import { openSync, writeSync, readSync, closeSync, fsyncSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { wavHeader } from './store.js';

export class Recording {
  constructor(store,settings,id,emit,onSummary,{replay=false}={}) {
    this.store=store; this.settings=settings; this.id=id; this.emit=emit; this.onSummary=onSummary;
    this.file=store.audioPath(id); this.fd=openSync(this.file,replay?'r+':'w+');
    this.bytes=replay?Math.max(0,statSync(this.file).size-44):0;
    writeSync(this.fd,wavHeader(this.bytes),0,44,0);
    this.stopping=replay; this.closed=false; this.paused=false; this.attempts=0; this.committed=0;
    this.lastSummary=0; this.lastAudio=Date.now(); this.sent=0;
    if (replay) this.committed=Math.min(this.bytes,Math.floor((store.record(id).segments.at(-1)?.end||0)*32000));
    this.committed-=this.committed%2;
    this.timer=setInterval(()=>this.tick(),100);
    this.connect();
  }
  notify(type,extra={}) { this.emit({type,id:this.id,...extra}); }
  append(data) {
    if (this.closed || this.stopping) return;
    if (this.paused) return;
    if (!data.length || data.length>64000 || data.length%2) throw new Error('音频数据格式不正确');
    writeSync(this.fd,data,0,data.length,44+this.bytes); this.bytes+=data.length;
    writeSync(this.fd,wavHeader(this.bytes),0,44,0); this.lastAudio=Date.now();
    if (this.bytes-(this.lastSync||0)>32000) { fsyncSync(this.fd); this.lastSync=this.bytes; }
  }
  connect() {
    if (this.closed) return;
    if (!this.settings.asrKey) { this.notify('asr-error',{message:'未配置转写密钥，正在仅保存录音。配置后可从档案补转写。'}); this.disabled=true; return; }
    this.base=this.committed; this.sent=this.base; this.ready=false; this.finishSent=false;
    this.task=randomUUID().replaceAll('-',''); this.connectAt=Date.now();
    try {
      this.upstream=new WebSocket(this.settings.asrUrl,{headers:{Authorization:`Bearer ${this.settings.asrKey}`},handshakeTimeout:15000,maxPayload:2*1024*1024});
    } catch { this.failed('转写地址无效'); return; }
    const ws=this.upstream;
    ws.on('open',()=>ws.send(JSON.stringify({header:{action:'run-task',task_id:this.task,streaming:'duplex'},payload:{task_group:'audio',task:'asr',function:'recognition',model:this.settings.asrModel,parameters:{format:'pcm',sample_rate:16000,heartbeat:true},input:{}}})));
    ws.on('message',raw=>{
      if (this.closed || ws!==this.upstream) return;
      try {
        const m=JSON.parse(raw); const event=m.header?.event;
        if (event==='task-started') { this.ready=true; this.notify('asr-ready'); }
        if (event==='result-generated') {
          const s=m.payload?.output?.sentence;
          if (!s?.text) return;
          const start=this.base/32000+Number(s.begin_time)/1000;
          const end=this.base/32000+Number(s.end_time)/1000;
          if (s.sentence_end===true && Number.isFinite(start) && Number.isFinite(end)) {
            const segment=this.store.segment(this.id,start,end,s.text);
            this.committed=Math.max(this.committed,Math.min(this.sent,Math.floor(end*16000)*2));
            this.attempts=0;
            if (segment) this.notify('segment',{segment});
          } else this.notify('partial',{text:s.text});
        }
        if (event==='task-failed') { this.failed(`转写任务失败（${String(m.header.error_code||'未知错误').slice(0,80)}），请检查模型、地域与权限。`); }
        if (event==='task-finished') {
          if(this.stopping && this.finishSent) this.finish(true);
          else this.failed('转写任务提前结束，正在重新连接并补传。');
        }
      } catch { this.failed('转写服务返回了无法解析的数据'); }
    });
    ws.on('error',()=>this.failed('转写网络连接失败，录音继续保存在本机。'));
    ws.on('close',()=>{ if (!this.closed && ws===this.upstream && !this.retryAt && !this.disabled) this.failed('转写连接断开，正在尝试从已确认文字之后补传。'); });
  }
  failed(message) {
    if (this.closed || this.retryAt || this.disabled) return;
    this.ready=false; this.attempts++;
    this.store.update(this.id,{warning:message}); this.notify('asr-error',{message});
    const ws=this.upstream; this.upstream=null; if (ws) ws.terminate();
    if (this.attempts>=4) { this.disabled=true; this.notify('asr-error',{message:'转写多次失败，已暂停重试。录音继续保存，结束后可在档案中补转写。'}); }
    else this.retryAt=Date.now()+Math.min(15000,1000*2**this.attempts);
  }
  tick() {
    try {
      if (this.closed) return;
      if (!this.stopping && !this.paused && Date.now()-this.lastAudio>20000) { this.stop(true,'超过20秒未收到电脑麦克风数据，录音已停止；请检查设备或页面状态。'); }
      if (!this.paused && this.retryAt && Date.now()>=this.retryAt) { this.retryAt=null; this.connect(); }
      if (!this.ready && this.upstream && Date.now()-this.connectAt>20000) this.failed('转写任务启动超时。');
      if (this.ready && this.upstream?.readyState===WebSocket.OPEN && !this.finishSent) {
        const n=Math.min(3200,this.bytes-this.sent);
        if (n>0 && this.upstream.bufferedAmount<64000) {
          const b=Buffer.alloc(n); readSync(this.fd,b,0,n,44+this.sent); this.upstream.send(b); this.sent+=n;
        }
        if (this.stopping && this.sent===this.bytes) {
          this.finishSent=true; this.finishAt=Date.now();
          this.upstream.send(JSON.stringify({header:{action:'finish-task',task_id:this.task,streaming:'duplex'},payload:{input:{}}}));
        }
      }
      if (this.finishSent && Date.now()-this.finishAt>20000) { this.stopWarning='转写结束响应超时，末尾文字可能缺失，可补转写。'; this.finish(false); }
      if (this.stopping && this.disabled) this.finish(false);
      const seconds=this.bytes/32000;
      if (Math.floor(seconds/600)>this.lastSummary) { this.lastSummary=Math.floor(seconds/600); this.onSummary(this.id,'auto'); }
      if (!this.paused && !this.closed && Date.now()-(this.lastUpdate||0)>1000) {
        this.lastUpdate=Date.now(); this.store.update(this.id,{duration:seconds});
        this.notify('progress',{duration:seconds,lag:Math.max(0,(this.bytes-this.sent)/32000)});
      }
    } catch { this.stopWarning='本地音频写入或读取失败，录音已停止。请检查磁盘空间。'; this.interrupted=true; this.finish(false); }
  }
  stop(interrupted=false,warning='') {
    if (this.closed || (this.stopping && !interrupted)) return;
    this.stopping=true; this.paused=false; this.interrupted=interrupted; this.stopWarning=warning;
    this.store.update(this.id,{status:'processing',duration:this.bytes/32000,paused:0});
    this.notify('processing',{message:warning||'录音已保存，正在等待末尾转写和总结。'});
    if (this.disabled) this.finish(false);
  }
  pause() {
    if (this.closed || this.stopping || this.paused) return;
    this.paused=true;
    const event=this.store.event(this.id,'pause',this.bytes/32000);
    this.store.update(this.id,{paused:1});
    this.notify('paused',{duration:this.bytes/32000,event});
  }
  resume() {
    if (this.closed || this.stopping || !this.paused) return;
    this.paused=false;
    this.lastAudio=Date.now();
    const event=this.store.event(this.id,'resume',this.bytes/32000);
    this.store.update(this.id,{paused:0});
    if(!this.disabled && !this.upstream && !this.retryAt)this.connect();
    this.notify('resumed',{duration:this.bytes/32000,event});
  }
  finish(success) {
    if (this.closed) return; this.closed=true; clearInterval(this.timer);
    this.upstream?.close();
    try { writeSync(this.fd,wavHeader(this.bytes),0,44,0); fsyncSync(this.fd); } finally { closeSync(this.fd); }
    const status=this.interrupted?'interrupted':success?'complete':'partial';
    this.store.update(this.id,{duration:this.bytes/32000,status,paused:0,warning:this.stopWarning||(success?'':'录音已保存，转写可能不完整；可使用补转写。')});
    this.notify('finished',{status}); this.onSummary(this.id,'final');
  }
  abort() { this.interrupted=true; this.stopWarning='程序或录音页面关闭，已保存收到的录音。'; this.finish(false); }
}
