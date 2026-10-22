import { readSync } from 'node:fs';
import { Recording } from './recording.js';
import { wavHeader } from './store.js';

// The STT endpoint accepts complete audio files, not a live WebSocket audio stream.
export class OpenRouterRecording extends Recording {
  connect() {
    if(this.closed)return;
    if(!this.settings.asrKey){this.disabled=true;this.notify('asr-error',{message:'未配置 OpenRouter 转写密钥，正在仅保存录音。'});return;}
    this.committed=Math.min(this.bytes,Math.max(this.committed,this.store.record(this.id).asr_offset||0));
    this.sent=this.committed;this.ready=true;
    this.notify('asr-ready',{message:'OpenRouter 分段转写 · 约每8秒提交一次，出字还需模型处理时间；回听按音频段定位。'});
  }
  tick() {
    if(this.closed)return;
    try {
      if(!this.stopping && !this.paused && Date.now()-this.lastAudio>20000)this.stop(true,'超过20秒未收到麦克风数据，已停止并保存录音。');
      if(this.closed)return;
      if(this.stopping && this.disabled){this.finish(false);return;}
      if(!this.paused && this.retryAt && Date.now()>=this.retryAt){this.retryAt=null;this.connect();}
      const seconds=this.bytes/32000;
      if(!this.stopping && Math.floor(seconds/600)>this.lastSummary){this.lastSummary=Math.floor(seconds/600);this.onSummary(this.id,'auto');}
      if(!this.paused && Date.now()-(this.lastUpdate||0)>1000){this.lastUpdate=Date.now();this.store.update(this.id,{duration:seconds});this.notify('progress',{duration:seconds,lag:(this.bytes-this.committed)/32000});}
      if(this.busy || this.disabled || this.retryAt)return;
      const available=this.bytes-this.committed;
      if(this.stopping && available===0){this.finish(true);return;}
      if(available>=8*32000 || (this.stopping && available>0)) void this.transcribe(Math.min(available,8*32000));
    } catch {this.stopWarning='本地音频处理失败，已停止录音，请检查磁盘。';this.interrupted=true;this.finish(false);}
  }
  async transcribe(length) {
    this.busy=true;const start=this.committed;this.controller=new AbortController();
    const timer=setTimeout(()=>this.controller?.abort(),60000);
    try {
      const pcm=Buffer.alloc(length);readSync(this.fd,pcm,0,length,44+start);
      const response=await fetch(this.settings.asrUrl.replace(/\/$/,'')+'/audio/transcriptions',{
        method:'POST',headers:{Authorization:`Bearer ${this.settings.asrKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:this.settings.asrModel,input_audio:{data:Buffer.concat([wavHeader(length),pcm]).toString('base64'),format:'wav'}}),
        signal:this.controller.signal,redirect:'error',
      });
      if(!response.ok){
        const hint={400:'请求或模型参数不受支持',401:'API Key 无效',402:'账户额度不足',403:'无权限',404:'转写模型或接口不存在',429:'请求限流'}[response.status]||'服务暂时不可用';
        const error=new Error(`OpenRouter 转写失败（HTTP ${response.status}）：${hint}。录音仍保存在电脑。`);
        error.permanent=[400,401,402,403,404].includes(response.status);throw error;
      }
      const result=await response.json();if(typeof result.text!=='string')throw new Error('OpenRouter 转写响应缺少 text 字段，已保留音频等待补转写。');
      if(this.closed)return;
      // Commit successful silent blocks too, so retries never skip or repeatedly submit them.
      this.store.db.exec('BEGIN');let segment;
      try {
        segment=this.store.segment(this.id,start/32000,(start+length)/32000,result.text);
        this.store.db.prepare('UPDATE records SET asr_offset=?, warning=? WHERE id=?').run(start+length,'',this.id);
        this.store.db.exec('COMMIT');
      }catch(error){this.store.db.exec('ROLLBACK');throw error;}
      this.committed=start+length;this.sent=this.committed;this.attempts=0;
      if(segment)this.notify('segment',{segment});
    }catch(error){
      if(!this.closed){if(error.permanent)this.attempts=3;this.failed(error.name==='AbortError'?'OpenRouter 转写超时，稍后重试；录音继续保存在本机。':error.message);}
    }finally{clearTimeout(timer);this.busy=false;}
  }
  finish(success){this.controller?.abort();super.finish(success);}
}

export function recordingClass(settings){return /^https?:/.test(settings.asrUrl||'')?OpenRouterRecording:Recording;}
