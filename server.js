import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from './lib/store.js';
import { Settings } from './lib/settings.js';
import { Recording } from './lib/recording.js';
import { recordingClass } from './lib/openrouter-recording.js';
import { summarize, ask, completion, generateTitle } from './lib/intelligence.js';
import { buildInterviewDocx } from './lib/docx.js';

const root=path.dirname(fileURLToPath(import.meta.url));
export function createApp({dataDir=path.join(root,'data'), settingsOverride}={}) {
  const store=new Store(dataDir), settings=new Settings(store), sessions=new Map(), jobs=new Map();
  const token=randomBytes(32).toString('hex');
  const getSettings=()=>settingsOverride || settings.get();
  const publicSettings=()=>settingsOverride?{...settingsOverride,asrKey:undefined,llmKey:undefined,asrConfigured:!!settingsOverride.asrKey,llmConfigured:!!settingsOverride.llmKey}:settings.public();
  const clients=new Set();
  const titleJobs=new Map(),titleTried=new Set();
  let closing=false;
  function broadcast(msg) {
    for(const ws of clients) if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
    if(msg.type==='segment' && !titleTried.has(msg.id) && store.record(msg.id).segments.map(s=>s.text).join('').length>=60){titleTried.add(msg.id);void titleJob(msg.id);}
  }
  async function titleJob(id,final=false){
    if(closing || !getSettings().llmKey)return;
    if(titleJobs.has(id)){await titleJobs.get(id);if(!final)return;}
    const job=generateTitle(store,getSettings(),id,{final}).then(r=>broadcast({type:'title',id,title:r.title})).catch(()=>broadcast({type:'title-error',id,message:'自动标题暂未生成，可在转写结束后重试。'}));
    titleJobs.set(id,job);await job;titleJobs.delete(id);
  }
  async function summaryJob(id,kind) {
    if(closing)return;
    if (jobs.has(id)) { if (kind==='final') jobs.get(id).final=true; return; }
    const job={final:false}; jobs.set(id,job); broadcast({type:'summary-busy',id});
    try { await summarize(store,getSettings(),id,kind); broadcast({type:'summary',id}); }
    catch(e) { broadcast({type:'summary-error',id,message:e.message}); }
    finally { jobs.delete(id); if(kind==='final')void titleJob(id,true);if(job.final) summaryJob(id,'final'); }
  }
  const validToken=t=>typeof t==='string' && t.length===token.length && timingSafeEqual(Buffer.from(t),Buffer.from(token));
  let origin='';
  function security(req,mutate=false) {
    if (req.headers.host!==new URL(origin).host) throw new Error('拒绝非本机来源');
    if(req.headers.origin && req.headers.origin!==origin) throw new Error('拒绝跨站请求');
    if(req.headers['sec-fetch-site']==='cross-site') throw new Error('拒绝跨站请求');
    if(mutate && !validToken(req.headers['x-app-token'])) throw new Error('会话已过期，请刷新页面');
  }
  const json=(res,data,code=200)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  async function body(req) {
    let value=''; for await (const b of req) {value+=b; if(Buffer.byteLength(value)>1024*1024) throw new Error('提交内容过大');}
    return value?JSON.parse(value):{};
  }
  const server=http.createServer(async(req,res)=>{
    try {
      security(req,req.method!=='GET');
      const url=new URL(req.url,origin), route=url.pathname, method=req.method;
      if(route==='/api/bootstrap') return json(res,{appId:'tingjijun',version:'0.2.1',features:['providers'],token,settings:publicSettings(),dataDir,active:[...sessions.values()].filter(s=>!s.closed).map(s=>s.id)});
      if(route==='/api/settings' && method==='POST') {if([...sessions.values()].some(s=>!s.closed)) throw new Error('请先结束录音和补转写，再修改模型配置。'); return json(res,settings.save(await body(req)));}
      if(route==='/api/settings/test' && method==='POST') {await completion(getSettings(),'你是连接测试助手。','请只回复“连接成功”。');return json(res,{ok:true});}
      if(route==='/api/records' && method==='GET') return json(res,store.list(Object.fromEntries(url.searchParams)));
      if(route==='/api/records' && method==='POST') {
        if([...sessions.values()].some(s=>!s.closed)) throw new Error('已有录音或补转写正在进行。');
        const b=await body(req);
        if(b.scenario!==undefined && !['meeting','interview'].includes(b.scenario))throw new Error('听记场景无效');
        return json(res,store.create(b));
      }
      const match=route.match(/^\/api\/records\/([a-f0-9-]{36})(?:\/(audio|summary|retry|segments|export|export-docx|delete|restore|title))?$/);
      if(match) {
        const [,id,action]=match; const record=store.record(id);
        if(['delete','restore'].includes(action) && method==='POST'){
          if(sessions.get(id) && !sessions.get(id).closed || jobs.has(id) || titleJobs.has(id))throw new Error('此记录正在录音或生成内容，请等待完成后再操作。');
          const r=action==='delete'?store.trash(id):store.restore(id);broadcast({type:'records-changed',id});return json(res,{ok:true,id:r.id});
        }
        if(record.deleted_at)throw new Error('记录已在回收站中，请先恢复。');
        if(action==='title' && method==='POST'){if(!getSettings().llmKey)throw new Error('请先配置语言模型');store.update(id,{title_mode:'auto'});void titleJob(id,true);return json(res,{queued:true});}
        if(action==='audio' && method==='GET') {
          const file=store.audioPath(id); if(!existsSync(file)) throw new Error('暂无录音文件');
          const size=statSync(file).size; const range=req.headers.range;
          if(range) {
            const m=range.match(/^bytes=(\d+)-(\d*)$/); if(!m) {res.writeHead(416);return res.end();}
            const start=Number(m[1]),end=m[2]?Math.min(size-1,Number(m[2])):size-1;
            if(start>=size || start>end) {res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
            res.writeHead(206,{'Content-Type':'audio/wav','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});
            return createReadStream(file,{start,end}).pipe(res);
          }
          res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':size,'Accept-Ranges':'bytes'}); return createReadStream(file).pipe(res);
        }
        if(action==='export' && method==='GET') {
          const summary=record.manual_summary ?? record.summaries.find(s=>s.kind!=='manual')?.body ?? '暂无总结';
          const scenario=record.scenario==='interview'?'面试':'会议';
          const timeline=[
            ...record.segments.map(s=>({order:0,at:s.start,text:`[${Math.floor(s.start/60)}:${String(Math.floor(s.start%60)).padStart(2,'0')}] ${s.text}`})),
            ...(record.events||[]).map(e=>({order:1,at:e.audio_at,text:`— ${e.kind==='pause'?'已暂停':'已继续'} ${new Date(e.created).toLocaleString('zh-CN',{hour12:false})} —`})),
          ].sort((a,b)=>a.at-b.at||a.order-b.order).map(item=>item.text).join('\n\n');
          const text=`# ${record.title}\n\n日期：${record.created}\n场景：${scenario}\n项目：${record.project}\n状态：${record.status}\n${record.warning}\n\n${summary}\n\n## 转写原文（可能经过人工修订）\n\n${timeline}`;
          res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="record-${id}.md"`}); return res.end(text);
        }
        if(action==='export-docx' && method==='GET') {
          const summary=record.manual_summary ?? record.summaries.find(s=>s.kind!=='manual')?.body;
          const buffer=await buildInterviewDocx(record,summary);
          const safeTitle=String(record.title||'面试').replace(/[\\/:*?"<>|]/g,'_').replace(/总结$/,'').slice(0,60)||'面试';
          res.writeHead(200,{
            'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Length':buffer.length,
            'Content-Disposition':`attachment; filename="interview-${id}.docx"; filename*=UTF-8''${encodeURIComponent(`${safeTitle}总结.docx`)}`,
          });
          return res.end(buffer);
        }
        if(action==='summary' && method==='POST') {summaryJob(id,'auto');return json(res,{queued:true});}
        if(action==='retry' && method==='POST') {
          if([...sessions.values()].some(s=>!s.closed)) throw new Error('请等待当前录音或转写结束。');
          if(!getSettings().asrKey) throw new Error('请先配置转写 API Key。');
          if(!existsSync(store.audioPath(id))) throw new Error('暂无录音文件');
          store.update(id,{status:'processing',paused:0});
          sessions.set(id,new (recordingClass(getSettings()))(store,getSettings(),id,broadcast,summaryJob,{replay:true})); return json(res,{queued:true});
        }
        if(action==='segments' && method==='POST') {
          const b=await body(req); if(typeof b.text!=='string' || b.text.length>20000) throw new Error('转写文字格式无效');
          store.editSegment(id,Number(b.id),b.text);return json(res,store.record(id));
        }
        if(!action && method==='GET') return json(res,record);
        if(!action && method==='POST') {
          const b=await body(req), patch={};
          for(const k of ['title','participants','manual_summary','scenario']) if(b[k]!==undefined) {
            if(typeof b[k]!=='string' || b[k].length>(k==='manual_summary'?50000:500)) throw new Error('编辑内容无效或过长');patch[k]=b[k];
          }
          if(patch.scenario!==undefined && !['meeting','interview'].includes(patch.scenario))throw new Error('听记场景无效');
          if(patch.manual_summary!==undefined) store.summary(id,patch.manual_summary,'manual',record.duration);
          if(patch.title!==undefined && patch.title!==record.title)patch.title_mode='manual';
          return json(res,store.update(id,patch));
        }
      }
      if(route==='/api/ask' && method==='POST') {const b=await body(req);if(typeof b.question!=='string' || b.question.length>2000) throw new Error('问题请控制在2000字以内');return json(res,await ask(store,getSettings(),b.question,b.filters||{}));}
      const staticFiles={'/':'index.html','/providers.js':'providers.js','/app.js':'app.js','/style.css':'style.css','/enhancements.css':'enhancements.css','/scenario.css':'scenario.css','/pcm-worklet.js':'pcm-worklet.js'};
      const vendors={'/vendor/marked.js':'marked/lib/marked.esm.js','/vendor/purify.js':'dompurify/dist/purify.es.mjs'};
      if(method==='GET' && vendors[route]){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','X-Content-Type-Options':'nosniff'});return res.end(readFileSync(path.join(root,'node_modules',vendors[route])));}
      if(method==='GET' && staticFiles[route]) {
        const mime=route.endsWith('.js')?'text/javascript':route.endsWith('.css')?'text/css':'text/html';
        res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"});
        return res.end(readFileSync(path.join(root,'public',staticFiles[route])));
      }
      json(res,{error:'页面或接口不存在'},404);
    } catch(e) { if(!res.headersSent) json(res,{error:e.message||'操作失败'},400); else res.end(); }
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
  server.on('upgrade',(req,socket,head)=>{
    try {security(req);const u=new URL(req.url,origin);if(u.pathname!=='/live' || !validToken(u.searchParams.get('token'))) throw new Error('Invalid session');wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));}
    catch{socket.destroy();}
  });
  wss.on('connection',ws=>{
    clients.add(ws);let owned;
    ws.on('message',(raw,binary)=>{
      try {
        if(binary) {if(owned && !owned.closed) owned.append(raw);return;}
        const b=JSON.parse(raw);
        if(b.type==='start') {
          if([...sessions.values()].some(s=>!s.closed)) throw new Error('已有录音正在进行');
          const r=store.record(b.id); if(r.status!=='recording' || existsSync(store.audioPath(b.id))) throw new Error('该记录不能重复开始');
          owned=new (recordingClass(getSettings()))(store,getSettings(),b.id,broadcast,summaryJob);sessions.set(b.id,owned);ws.send(JSON.stringify({type:'started',id:b.id}));
        }
        if(b.type==='stop' && owned) owned.stop();
        if(b.type==='pause'){if(!owned)throw new Error('没有可暂停的录音');owned.pause();}
        if(b.type==='resume'){if(!owned)throw new Error('没有可继续的录音');owned.resume();}
        if(b.type==='interrupt' && owned) owned.stop(true,'麦克风或采集页面中断，已保存接收到的录音。');
      } catch(e) {if(owned && !owned.closed) owned.stop(true,'采集发生错误，已停止录音。');ws.send(JSON.stringify({type:'error',message:e.message}));}
    });
    ws.on('close',()=>{clients.delete(ws);if(owned && !owned.stopping && !owned.closed) owned.stop(true,'录音页面断开，已保存收到的音频。');});
    ws.on('error',()=>{});
  });
  return {store,server,async listen(port=4317) {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;return origin;},async close(){closing=true;for(const s of sessions.values()) if(!s.closed)s.abort();for(const ws of clients)ws.terminate();await new Promise(r=>server.close(r));await Promise.allSettled(titleJobs.values());store.close();}};
}
if(process.argv[1] && realpathSync(process.argv[1]).toLowerCase()===realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const app=createApp();
  app.listen(Number(process.env.PORT)||4317).then(url=>console.log(`听记君已启动：${url}\n关闭此进程会停止服务。`)).catch(e=>{console.error(e.code==='EADDRINUSE'?'端口4317已被使用。请检查是否已启动听记君。':e.message);process.exit(1);});
  for(const sig of ['SIGINT','SIGTERM']) process.on(sig,async()=>{await app.close();process.exit(0);});
}
