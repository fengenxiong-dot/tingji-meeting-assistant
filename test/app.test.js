import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import { Store, retrieve, wavHeader } from '../lib/store.js';
import { summarize, ask } from '../lib/intelligence.js';
import { Recording } from '../lib/recording.js';
import { createApp } from '../server.js';
import { resolveDateFilters } from '../lib/dates.js';
import { Settings } from '../lib/settings.js';
import vm from 'node:vm';
import { OpenRouterRecording } from '../lib/openrouter-recording.js';
import { generateTitle, completionBody } from '../lib/intelligence.js';
import { buildInterviewDocx } from '../lib/docx.js';
import { languageProviders, identifyProvider } from '../public/providers.js';

function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'tingjijun-test-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
test('各服务商请求参数遵循对应协议，自定义地址不误加扩展参数',()=>{
  const body=(id,model,fastMode=true)=>completionBody({llmUrl:languageProviders[id].url,llmModel:model||languageProviders[id].models[0],fastMode},'输出 JSON','q',true);
  assert.deepEqual(body('deepseek').thinking,{type:'disabled'});
  assert.equal(body('deepseek',undefined,false).thinking,undefined);
  assert.deepEqual(body('kimi').thinking,{type:'disabled'});
  assert.equal(body('kimi').temperature,undefined);
  assert.equal(body('kimi','kimi-k3').reasoning_effort,'low');
  assert.equal(body('kimi','kimi-k3').thinking,undefined);
  assert.equal(body('kimi','kimi-k2.7-code').thinking,undefined);
  assert.deepEqual(body('zhipu').thinking,{type:'disabled'});
  assert.equal(body('qwen').enable_thinking,false);
  assert.equal(body('qwen',undefined,false).enable_thinking,false);
  assert.equal(identifyProvider('https://api.deepseek.com.evil.test'),'custom');
  assert.equal(identifyProvider('https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),'qwen');
  assert.equal(identifyProvider('https://api.moonshot.ai/v1'),'kimi');
});
test('切换服务地址不能复用旧密钥，失败保存保持原配置', {skip:process.platform!=='win32'},t=>{
  const store=fixture(t),s=new Settings(store);
  s.save({llmKey:'test-only-router'});
  assert.throws(()=>s.save({llmUrl:languageProviders.deepseek.url,llmModel:'deepseek-flash'}),/对应的 API Key/);
  assert.equal(s.get().llmUrl,languageProviders.openrouter.url);
  s.save({llmUrl:languageProviders.deepseek.url,llmModel:'deepseek-flash',llmKey:'test-only-deepseek'});
  assert.equal(s.get().llmKey,'test-only-deepseek');
  assert.equal(s.public().llmSecret,undefined);
  s.save({llmModel:'deepseek-v4-pro'});
  assert.equal(s.get().llmKey,'test-only-deepseek');
});
function waitUntil(check,ms=5000){return new Promise((resolve,reject)=>{const end=Date.now()+ms;const tick=()=>{if(check())resolve();else if(Date.now()>end)reject(new Error('condition timed out'));else setTimeout(tick,20);};tick();});}
test('原文修订、日期过滤、跨记录证据和相邻上下文',t=>{
  const store=fixture(t),a=store.create({title:'项目 A 报价讨论',project:'A'}),b=store.create({title:'B 会议'});
  store.db.prepare('UPDATE records SET created=? WHERE id=?').run('2026-03-10T02:00:00Z',a.id);
  const s=store.segment(a.id,0,5,'报价为十万元。');store.segment(a.id,5,10,'但不包含维护费用。');store.segment(b.id,0,4,'主题 B 已完成。');
  store.editSegment(a.id,s.id,'报价为十二万元。');
  assert.equal(store.record(a.id).segments[0].original,'报价为十万元。');
  assert.equal(store.list({q:'十二万',from:'2026-03-01',to:'2026-03-31'}).length,1);
  const results=retrieve(store,'项目 A 报价是多少',{from:'2026-03-01',to:'2026-03-31'});
  assert.equal(results.sources.length,2);assert.ok(results.sources.some(s=>s.text.includes('不包含')));
  assert.ok(results.sources.every(s=>s.record_id===a.id));
});
test('听记场景持久化，旧记录默认会议场景',t=>{
  const store=fixture(t),a=store.create({title:'会议'}),b=store.create({title:'面试',scenario:'interview'});
  assert.equal(a.scenario,'meeting');assert.equal(b.scenario,'interview');
  store.update(a.id,{scenario:'interview'});assert.equal(store.record(a.id).scenario,'interview');
});
test('异常退出恢复 WAV 头和录音状态',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'tingjijun-recovery-'));let store=new Store(dir);const r=store.create();
  writeFileSync(store.audioPath(r.id),Buffer.concat([wavHeader(0),Buffer.alloc(64000)]));store.close();
  store=new Store(dir);try{assert.equal(store.record(r.id).status,'interrupted');assert.equal(store.record(r.id).duration,2);assert.equal(readFileSync(store.audioPath(r.id)).readUInt32LE(40),64000);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('流式协议保存尾句，音频和时间戳一致',async t=>{
  const store=fixture(t),r=store.create();const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');t.after(()=>upstream.close());
  let bytes=0,started=false,finishSeen=false;
  upstream.on('connection',ws=>ws.on('message',(raw,binary)=>{
    if(binary){assert.ok(started);bytes+=raw.length;return;}
    const m=JSON.parse(raw);if(m.header.action==='run-task'){assert.equal(m.payload.parameters.format,'pcm');assert.equal(m.payload.model,'test');started=true;ws.send(JSON.stringify({header:{event:'task-started'}}));}
    if(m.header.action==='finish-task'){finishSeen=true;ws.send(JSON.stringify({header:{event:'result-generated'},payload:{output:{sentence:{begin_time:0,end_time:200,text:'测试尾句。',sentence_end:true}}}}));ws.send(JSON.stringify({header:{event:'task-finished'}}));}
  }));
  const events=[];const rec=new Recording(store,{asrUrl:`ws://127.0.0.1:${upstream.address().port}`,asrKey:'fake',asrModel:'test'},r.id,e=>events.push(e),()=>{});t.after(()=>{if(!rec.closed)rec.abort();});
  rec.append(Buffer.alloc(6400));rec.stop();await waitUntil(()=>rec.closed);
  assert.equal(bytes,6400);assert.ok(finishSeen);assert.equal(store.record(r.id).segments[0].text,'测试尾句。');assert.equal(store.record(r.id).status,'complete');assert.equal(readFileSync(store.audioPath(r.id)).length,6444);
});
test('没有密钥时仍保存音频，并明确标记转写未完成',async t=>{
  const store=fixture(t),r=store.create(),events=[];const rec=new Recording(store,{asrKey:''},r.id,e=>events.push(e),()=>{});
  rec.append(Buffer.alloc(3200));rec.stop();assert.equal(store.record(r.id).status,'partial');assert.equal(store.record(r.id).duration,.1);assert.ok(events.some(e=>e.type==='asr-error'));assert.equal(readFileSync(store.audioPath(r.id)).readUInt32LE(40),3200);
});
test('暂停和继续作用于同一条录音，暂停期间音频不写入',t=>{
  const store=fixture(t),r=store.create(),events=[];const rec=new Recording(store,{asrKey:''},r.id,e=>events.push(e),()=>{});
  rec.append(Buffer.alloc(3200));rec.pause();assert.equal(store.record(r.id).paused,1);assert.deepEqual(store.record(r.id).events.map(e=>e.kind),['pause']);
  rec.append(Buffer.alloc(3200));assert.equal(readFileSync(store.audioPath(r.id)).readUInt32LE(40),3200);
  rec.resume();assert.equal(store.record(r.id).paused,0);assert.deepEqual(store.record(r.id).events.map(e=>e.kind),['pause','resume']);
  rec.append(Buffer.alloc(3200));rec.stop();assert.equal(store.record(r.id).status,'partial');assert.equal(store.record(r.id).duration,.2);assert.equal(readFileSync(store.audioPath(r.id)).readUInt32LE(40),6400);
  assert.ok(events.some(e=>e.type==='paused'));assert.ok(events.some(e=>e.type==='resumed'));
});
test('每 10 分钟只触发一次阶段总结，结束后触发最终总结',t=>{
  const store=fixture(t),r=store.create(),calls=[];const rec=new Recording(store,{asrKey:''},r.id,()=>{},(...args)=>calls.push(args));
  rec.bytes=600*32000;rec.tick();rec.tick();assert.equal(calls.filter(c=>c[1]==='auto').length,1);
  rec.bytes=0;rec.stop();assert.equal(calls.filter(c=>c[1]==='final').length,1);
});
test('总结不覆盖人工版本，问答拒绝伪造来源',async t=>{
  const store=fixture(t),r=store.create({title:'报价'});store.segment(r.id,0,1,'报价十二万元。');store.update(r.id,{manual_summary:'人工确认：不含税。'});
  let invalid=false;
  const mock=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);const planning=b.messages[0].content.includes('检索关键词');const answering=b.messages[0].content.includes('本地会议档案助手');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:planning?' {"terms":["报价"]}':answering?(invalid?'报价十二万元。[S999]':'报价十二万元。[S1]'):'## 会议摘要\n报价十二万元。'},finish_reason:'stop'}]}));});
  mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>mock.close());const settings={llmUrl:`http://127.0.0.1:${mock.address().port}`,llmKey:'fake',llmModel:'test'};
  await summarize(store,settings,r.id);assert.equal(store.record(r.id).manual_summary,'人工确认：不含税。');assert.equal(store.record(r.id).summaries.length,1);
  const answer=await ask(store,settings,'报价多少？');assert.equal(answer.sources[0].text,'报价十二万元。');invalid=true;await assert.rejects(()=>ask(store,settings,'报价多少？'),/有效来源/);
});
test('面试场景使用专用总结结构并禁止做是否通过评价',async t=>{
  const store=fixture(t),r=store.create({title:'后端工程师面试',scenario:'interview'});store.segment(r.id,0,8,'候选人介绍自己负责过订单系统和团队排期，回答了数据库索引问题。');
  const prompts=[];const mock=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);prompts.push(b.messages[0].content);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'## 核心问答记录\n- 问题：数据库索引\n- 回答要点：结合订单系统说明。\n\n## 初步评价\n- 专业基础：有实际经验，其他维度暂无足够信息。'},finish_reason:'stop'}]}));});
  mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>mock.close());
  await summarize(store,{llmUrl:`http://127.0.0.1:${mock.address().port}`,llmKey:'test',llmModel:'test'},r.id);
  assert.match(prompts[0],/核心问答记录/);assert.match(prompts[0],/初步评价/);assert.match(prompts[0],/不得评价是否通过/);assert.match(store.record(r.id).summaries[0].body,/初步评价/);
});
test('面试总结生成有效 Word 文档，非面试场景拒绝导出',async t=>{
  const store=fixture(t),r=store.create({title:'后端工程师面试',scenario:'interview'});
  store.update(r.id,{participants:'候选人 A'});store.segment(r.id,0,8,'候选人介绍了订单系统项目。');
  const summary='## 核心问答记录\n- 问题：介绍项目\n- 回答要点：负责订单系统。\n\n## 初步评价\n- 专业基础：有实际经验。';
  store.summary(r.id,summary,'final',8);
  const buffer=await buildInterviewDocx(store.record(r.id),summary);
  assert.ok(Buffer.isBuffer(buffer));assert.equal(buffer.subarray(0,2).toString(),'PK');assert.ok(buffer.length>2000);
  await assert.rejects(()=>buildInterviewDocx(store.create({title:'普通会议'}),summary),/仅面试场景/);
});
test('HTTP 会话防跨站、音频范围读取、存档编辑',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'tingjijun-api-'));const app=createApp({dataDir:dir});const url=await app.listen(0);t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const bootstrap=await (await fetch(url+'/api/bootstrap')).json();assert.equal(typeof bootstrap.token,'string');assert.equal(bootstrap.settings.asrKey,undefined);
  let resp=await fetch(url+'/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(resp.status,400);
  resp=await fetch(url+'/api/records',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':bootstrap.token,Origin:'https://example.com'},body:'{}'});assert.equal(resp.status,400);
  resp=await fetch(url+'/api/records',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':bootstrap.token},body:JSON.stringify({title:'API 测试',scenario:'interview'})});const r=await resp.json();assert.equal(r.title,'API 测试');assert.equal(r.scenario,'interview');
  app.store.segment(r.id,0,1,'候选人回答测试问题。');app.store.summary(r.id,'## 核心问答记录\n- 问题：测试\n- 回答要点：已回答。\n\n## 初步评价\n- 逻辑思维：回答完整。','final',1);
  resp=await fetch(`${url}/api/records/${r.id}/export-docx`);assert.equal(resp.status,200);assert.equal(resp.headers.get('content-type'),'application/vnd.openxmlformats-officedocument.wordprocessingml.document');assert.equal(Buffer.from(await resp.arrayBuffer()).subarray(0,2).toString(),'PK');
  resp=await fetch(url+'/api/records',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':bootstrap.token},body:JSON.stringify({title:'无效场景',scenario:'other'})});assert.equal(resp.status,400);
  resp=await fetch(`${url}/api/records/${r.id}`,{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':bootstrap.token},body:JSON.stringify({scenario:'meeting'})});assert.equal((await resp.json()).scenario,'meeting');
  resp=await fetch(`${url}/api/records/${r.id}/export-docx`);assert.equal(resp.status,400);
  writeFileSync(app.store.audioPath(r.id),Buffer.concat([wavHeader(3200),Buffer.alloc(3200)]));
  resp=await fetch(`${url}/api/records/${r.id}/audio`,{headers:{Range:'bytes=44-143'}});assert.equal(resp.status,206);assert.equal((await resp.arrayBuffer()).byteLength,100);
  resp=await fetch(url+'/api/bootstrap',{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(resp.status,400);
});
test('中文月份、最近一个月和人工日期范围',()=>{
  const now=new Date('2026-09-15T04:00:00Z');
  assert.deepEqual(resolveDateFilters('找下三月 B 主题会议',{},now),{from:'2026-03-01',to:'2026-03-31'});
  assert.deepEqual(resolveDateFilters('2024年二月的会议',{},now),{from:'2024-02-01',to:'2024-02-29'});
  assert.deepEqual(resolveDateFilters('最近一个月的待办',{},now),{from:'2026-08-16',to:'2026-09-15'});
  assert.deepEqual(resolveDateFilters('三月',{from:'2025-03-01',to:'2025-03-31'},now),{from:'2025-03-01',to:'2025-03-31'});
  assert.throws(()=>resolveDateFilters('问题',{from:'2026-10-01',to:'2026-01-01'},now));
});
test('44.1kHz 与 48kHz 麦克风转换为完整的 16kHz PCM，停止时刷新尾块',()=>{
  for(const rate of [44100,48000,16000]){
    let Recorder;const frames=[];
    const context=vm.createContext({AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>frames.push(m)};}},sampleRate:rate,registerProcessor:(_name,C)=>{Recorder=C;},Int16Array,Math});
    vm.runInContext(readFileSync(new URL('../public/pcm-worklet.js',import.meta.url),'utf8'),context);const recorder=new Recorder();
    const count=rate+Math.floor(rate/10);
    for(let i=0;i<count;i+=128)recorder.process([[new Float32Array(Math.min(128,count-i)).fill(.5)]]);
    recorder.port.onmessage({data:'stop'});
    const samples=frames.filter(f=>f.pcm).flatMap(f=>[...new Int16Array(f.pcm)]);
    assert.equal(samples.length,17600);assert.ok(samples.every(v=>Math.abs(v-16384)<=1));assert.ok(frames.at(-1).stopped);
  }
});
test('补转写从已确认末尾继续，保留人工修订与绝对时间位置',async t=>{
  const store=fixture(t),r=store.create();store.segment(r.id,0,.2,'前一句已确认');
  writeFileSync(store.audioPath(r.id),Buffer.concat([wavHeader(12800),Buffer.alloc(12800)]));
  const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');t.after(()=>upstream.close());let bytes=0;
  upstream.on('connection',ws=>ws.on('message',(raw,binary)=>{if(binary){bytes+=raw.length;return;}const m=JSON.parse(raw);if(m.header.action==='run-task')ws.send(JSON.stringify({header:{event:'task-started'}}));if(m.header.action==='finish-task'){ws.send(JSON.stringify({header:{event:'result-generated'},payload:{output:{sentence:{begin_time:0,end_time:200,text:'补转写的尾句',sentence_end:true}}}}));ws.send(JSON.stringify({header:{event:'task-finished'}}));}}));
  const rec=new Recording(store,{asrUrl:`ws://127.0.0.1:${upstream.address().port}`,asrKey:'fake',asrModel:'test'},r.id,()=>{},()=>{},{replay:true});t.after(()=>{if(!rec.closed)rec.abort();});await waitUntil(()=>rec.closed);
  assert.equal(bytes,6400);assert.equal(store.record(r.id).segments.length,2);assert.equal(store.record(r.id).segments[1].start,.2);assert.equal(store.record(r.id).segments[1].end,.4);
});
test('Windows 密钥加密落盘，读取接口不暴露密钥', {skip:process.platform!=='win32'},t=>{
  const store=fixture(t),settings=new Settings(store);settings.save({asrKey:'test-only-asr-secret',llmKey:'test-only-llm-secret'});
  const persisted=store.db.prepare('SELECT body FROM settings').get().body;assert.ok(!persisted.includes('test-only'));
  assert.equal(settings.get().asrKey,'test-only-asr-secret');assert.equal(settings.public().asrKey,undefined);
  settings.save({llmModel:'other-model'});assert.equal(settings.get().llmKey,'test-only-llm-secret');
});
test('浏览器 WebSocket 通道完整录音、结束并保存档案',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'tingjijun-lifecycle-'));const app=createApp({dataDir:dir,settingsOverride:{asrKey:'',llmKey:''}});const url=await app.listen(0);
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const boot=await(await fetch(url+'/api/bootstrap')).json();const record=await(await fetch(url+'/api/records',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':boot.token},body:'{"title":"生命周期测试"}'})).json();
  const socket=new WebSocket(url.replace('http','ws')+'/live?token='+boot.token,{headers:{Origin:url}});t.after(()=>socket.terminate());await once(socket,'open');
  const events=[];socket.on('message',raw=>events.push(JSON.parse(raw)));socket.send(JSON.stringify({type:'start',id:record.id}));await waitUntil(()=>events.some(e=>e.type==='started'));
  socket.send(Buffer.alloc(16000));socket.send(JSON.stringify({type:'pause'}));await waitUntil(()=>events.some(e=>e.type==='paused'));
  socket.send(Buffer.alloc(16000));socket.send(JSON.stringify({type:'resume'}));await waitUntil(()=>events.some(e=>e.type==='resumed'));
  socket.send(Buffer.alloc(16000));socket.send(JSON.stringify({type:'stop'}));await waitUntil(()=>events.some(e=>e.type==='finished'));
  const saved=await(await fetch(`${url}/api/records/${record.id}`)).json();assert.equal(saved.duration,1);assert.equal(saved.status,'partial');assert.deepEqual(saved.events.map(e=>e.kind),['pause','resume']);assert.equal(readFileSync(app.store.audioPath(record.id)).length,32044);
});
test('OpenRouter 按8秒切分，停止时补交尾块，时间位置连续',async t=>{
  const store=fixture(t),r=store.create(),requests=[];
  const mock=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);assert.equal(req.url,'/api/v1/audio/transcriptions');assert.equal(body.model,'qwen/qwen3-asr-0.6b');const wav=Buffer.from(body.input_audio.data,'base64');requests.push(wav.length-44);assert.equal(wav.readUInt32LE(40),wav.length-44);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:requests.length===1?'前段':'尾段'}));});
  mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>mock.close());
  const rec=new OpenRouterRecording(store,{asrUrl:`http://127.0.0.1:${mock.address().port}/api/v1`,asrModel:'qwen/qwen3-asr-0.6b',asrKey:'test'},r.id,()=>{},()=>{});t.after(()=>{if(!rec.closed)rec.abort();});
  for(let i=0;i<4;i++)rec.append(Buffer.alloc(64000));rec.append(Buffer.alloc(16000));rec.stop();await waitUntil(()=>rec.closed);
  assert.deepEqual(requests,[256000,16000]);const saved=store.record(r.id);assert.equal(saved.status,'complete');assert.equal(saved.asr_offset,272000);assert.deepEqual(saved.segments.map(s=>[s.start,s.end]),[[0,8],[8,8.5]]);
});
test('OpenRouter 失败重试同一音频块，空白成功结果也保存进度',async t=>{
  const store=fixture(t),r=store.create(),requests=[];
  const mock=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;requests.push(JSON.parse(raw).input_audio.data);res.setHeader('Content-Type','application/json');if(requests.length===1){res.writeHead(503);res.end('{}');}else res.end('{"text":""}');});
  mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>mock.close());
  const rec=new OpenRouterRecording(store,{asrUrl:`http://127.0.0.1:${mock.address().port}`,asrModel:'test',asrKey:'test'},r.id,()=>{},()=>{});t.after(()=>{if(!rec.closed)rec.abort();});rec.append(Buffer.alloc(3200));rec.stop();await waitUntil(()=>rec.closed,6000);
  assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);assert.equal(store.record(r.id).asr_offset,3200);assert.equal(store.record(r.id).segments.length,0);assert.equal(store.record(r.id).status,'complete');
});
test('OpenRouter 无效密钥保留录音，不消耗转写进度',async t=>{
  const store=fixture(t),r=store.create();const mock=http.createServer((req,res)=>{req.resume();res.writeHead(401);res.end('{}');});mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>mock.close());
  const rec=new OpenRouterRecording(store,{asrUrl:`http://127.0.0.1:${mock.address().port}`,asrKey:'bad'},r.id,()=>{},()=>{});t.after(()=>{if(!rec.closed)rec.abort();});rec.append(Buffer.alloc(3200));rec.stop();await waitUntil(()=>rec.closed);
  assert.equal(store.record(r.id).status,'partial');assert.equal(store.record(r.id).asr_offset,0);assert.equal(readFileSync(store.audioPath(r.id)).length,3244);
});
test('自动标题生成，人工标题不会被迟到的模型响应覆盖',async t=>{
  const store=fixture(t),r=store.create();store.segment(r.id,0,8,'我们讨论了报价和交付时间，确定下周交付。');let duringResponse=()=>{};
  const mock=http.createServer(async(req,res)=>{for await(const b of req){}duringResponse();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'报价与交付安排'},finish_reason:'stop'}]}));});mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>mock.close());
  const settings={llmKey:'test',llmUrl:`http://127.0.0.1:${mock.address().port}`,llmModel:'test'};
  await generateTitle(store,settings,r.id);assert.equal(store.record(r.id).title,'报价与交付安排');assert.equal(store.record(r.id).title_generated,1);
  duringResponse=()=>store.update(r.id,{title:'人工标题',title_mode:'manual'});await generateTitle(store,settings,r.id,{final:true});assert.equal(store.record(r.id).title,'人工标题');
});
test('回收站删除排除检索，恢复保留音频、转写和总结',t=>{
  const store=fixture(t),r=store.create({title:'报价讨论'});store.segment(r.id,0,1,'报价为十万');store.summary(r.id,'## 结论\n确定十万');writeFileSync(store.audioPath(r.id),wavHeader(0));
  store.trash(r.id);assert.equal(store.list().length,0);assert.equal(store.list({trash:true}).length,1);assert.equal(retrieve(store,'报价',{trash:true}).sources.length,0);
  store.restore(r.id);assert.equal(store.list().length,1);assert.equal(store.record(r.id).summaries.length,1);assert.equal(retrieve(store,'报价').sources.length,1);assert.equal(readFileSync(store.audioPath(r.id)).length,44);
});
test('快速模式关闭 OpenRouter 推理，可显式恢复模型默认',()=>{
  const settings={llmUrl:'https://openrouter.ai/api/v1',llmModel:'~deepseek/deepseek-pro-latest'};
  assert.deepEqual(completionBody(settings,'s','q').reasoning,{effort:'none'});
  assert.equal(completionBody({...settings,fastMode:false},'s','q').reasoning,undefined);
  assert.equal(completionBody({...settings,llmUrl:'https://another.example/v1'},'s','q').reasoning,undefined);
});
test('本地检索命中时只调用模型一次回答，省去关键词提取等待',async t=>{
  const store=fixture(t),r=store.create();store.segment(r.id,0,1,'报价十万元');let calls=0;
  const mock=http.createServer(async(req,res)=>{for await(const b of req){}calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'报价十万元。[S1]'},finish_reason:'stop'}]}));});mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>mock.close());
  await ask(store,{llmUrl:`http://127.0.0.1:${mock.address().port}`,llmKey:'test',llmModel:'test'},'报价多少');assert.equal(calls,1);
});
