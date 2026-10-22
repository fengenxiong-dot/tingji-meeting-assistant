export const languageProviders = {
  openrouter:{name:'OpenRouter',url:'https://openrouter.ai/api/v1',models:['~deepseek/deepseek-pro-latest'],help:'使用 OpenRouter Key；模型名称填写平台完整 ID（含供应商前缀）。'},
  deepseek:{name:'DeepSeek 官方',url:'https://api.deepseek.com',models:['deepseek-flash','deepseek-v4-pro'],help:'使用 DeepSeek 开放平台 API Key，网页会员与 API 额度分开。'},
  kimi:{name:'Kimi / 月之暗面',url:'https://api.moonshot.cn/v1',models:['kimi-k2.6','kimi-k3'],help:'使用 Kimi 开放平台 Key。K2.6 支持关闭思考；K3 快速模式降低推理强度，不能关闭思考。国际账号可修改为 api.moonshot.ai/v1。'},
  zhipu:{name:'智谱 GLM',url:'https://open.bigmodel.cn/api/paas/v4',models:['glm-4.7','glm-4.7-flash'],help:'使用智谱开放平台通用 API Key 与接口；不是 Coding Plan 专用地址。'},
  qwen:{name:'千问 / 阿里云百炼',url:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:['qwen-plus','qwen-flash','qwen-max'],help:'使用百炼 Key；地址与 Key 的地域必须一致。支持按控制台修改为业务空间专属地址。'},
  custom:{name:'自定义兼容接口',url:'',models:[],help:'填写 HTTPS 基础地址、模型 ID 和对应 Key。须支持 Chat Completions；未知服务不发送专用思考参数。'}
};
export const speechProviders = {
  openrouter:{name:'OpenRouter 分段转写',url:'https://openrouter.ai/api/v1',models:['qwen/qwen3-asr-0.6b'],help:'约每 8 秒提交音频，返回后更新文字；使用 OpenRouter Key。'},
  qwen:{name:'千问 / 百炼流式转写',url:'wss://dashscope.aliyuncs.com/api-ws/v1/inference',models:['qwen-audio-3.0-asr-flash-streaming'],help:'使用百炼 Key 和 inference WebSocket 地址；可按控制台修改地域或业务空间地址，不支持 flash-realtime 协议。'}
};
export function identifyProvider(url,speech=false){
  let u;try{u=new URL(url);}catch{return 'custom';}
  const h=u.hostname;
  if(h==='openrouter.ai')return 'openrouter';
  if(h==='dashscope.aliyuncs.com'||h.startsWith('dashscope-')&&h.endsWith('.aliyuncs.com')||h.endsWith('.maas.aliyuncs.com'))return 'qwen';
  if(speech)return 'custom';
  if(h==='api.deepseek.com')return 'deepseek';
  if(['api.moonshot.cn','api.moonshot.ai'].includes(h))return 'kimi';
  if(h==='open.bigmodel.cn')return 'zhipu';
  return 'custom';
}
