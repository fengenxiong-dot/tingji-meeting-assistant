import { execFileSync } from 'node:child_process';

const defaults = {
  fastMode: true,
  asrUrl: 'https://openrouter.ai/api/v1',
  asrModel: 'qwen/qwen3-asr-0.6b',
  llmUrl: 'https://openrouter.ai/api/v1', llmModel: '~deepseek/deepseek-pro-latest',
};
function protect(value, decrypt=false) {
  if (process.platform !== 'win32') throw new Error('密钥持久保存目前仅支持 Windows；其他系统请使用环境变量。');
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${decrypt?'Unprotect':'Protect'}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const out = execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
    input:decrypt?value:Buffer.from(value).toString('base64'),windowsHide:true,encoding:'utf8',timeout:10000,
  }).trim();
  return decrypt?Buffer.from(out,'base64').toString():out;
}
export class Settings {
  constructor(store) { this.store=store; this.cached=null; }
  get() {
    if (this.cached) return {...this.cached};
    const row=this.store.db.prepare('SELECT body FROM settings WHERE id=1').get();
    const s={...defaults,...(row?JSON.parse(row.body):{})};
    s.keyWarning=false;
    const read=(secret,fallback)=>{if(!secret)return fallback;try{return protect(secret,true);}catch{s.keyWarning=true;return '';}};
    s.asrKey=read(s.asrSecret,process.env.DASHSCOPE_API_KEY||'');
    s.llmKey=read(s.llmSecret,process.env.LLM_API_KEY||'');
    this.cached=s; return {...s};
  }
  public() { const s=this.get(); return {...defaults,asrUrl:s.asrUrl,asrModel:s.asrModel,llmUrl:s.llmUrl,llmModel:s.llmModel,asrConfigured:!!s.asrKey,llmConfigured:!!s.llmKey,keyWarning:s.keyWarning,fastMode:s.fastMode}; }
  save(input) {
    const s=this.get();
    const previous={asr:s.asrUrl,llm:s.llmUrl};
    for (const k of Object.keys(defaults)) if (input[k]!==undefined) s[k]=k==='fastMode'?input[k]===true:String(input[k]).trim();
    for (const k of ['asrUrl','llmUrl']) {
      let u;try{u=new URL(s[k]);}catch{throw new Error(`${k==='asrUrl'?'语音转写':'语言模型'}：请输入包含 https:// 的完整 API 地址。`);}
      if (!(k==='asrUrl'?['wss:','https:']:['https:']).includes(u.protocol) || u.username || u.password || u.hash || u.search || /[{}]/.test(s[k])) throw new Error(`${k==='asrUrl'?'语音转写':'语言模型'}地址无效，请检查协议和占位符。`);
      if(k==='asrUrl' && u.protocol==='https:' && u.hostname!=='openrouter.ai') throw new Error('HTTPS 转写当前适配 OpenRouter，请填写 https://openrouter.ai/api/v1。');
      s[k]=s[k].replace(/\/+$/,'').replace(k==='asrUrl'?/\/audio\/transcriptions$/:/\/chat\/completions$/,'');
    }
    if (!s.asrModel || !s.llmModel) throw new Error('请填写模型名称');
    for(const type of ['asr','llm']){
      if(new URL(previous[type]).origin!==new URL(s[type+'Url']).origin && !input[type+'Key']?.trim()){
        if(s[type+'Secret'] || s[type+'Key'])throw new Error('切换 API 服务地址后，请填写新服务对应的 API Key；原设置尚未更改。');
      }
    }
    if (s.asrUrl.startsWith('wss:') && s.asrModel.includes('flash-realtime')) throw new Error('此 WebSocket 接口使用 inference 协议，请使用 qwen-audio-3.0-asr-flash-streaming。');
    if (input.asrKey?.trim()) s.asrSecret=protect(input.asrKey.trim());
    if (input.llmKey?.trim()) s.llmSecret=protect(input.llmKey.trim());
    delete s.asrKey; delete s.llmKey;
    this.store.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(s));
    this.cached=null; return this.public();
  }
}
