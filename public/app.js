import { languageProviders, speechProviders, identifyProvider } from '/providers.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
const $=s=>document.querySelector(s);
const markdown=s=>DOMPurify.sanitize(marked.parse(String(s||'')),{USE_PROFILES:{html:true},FORBID_TAGS:['img','iframe','form','input','style'],FORBID_ATTR:['style']});
const scenarioName=s=>s==='interview'?'面试场景':'会议场景';
const scenarioKind=s=>s==='interview'?'interview':'meeting';
function applyScenarioUI(scenario){
  const s=scenarioKind(scenario);
  $('#scenario').value=s;$('#meta-scenario').value=s;
  $('#summary-heading').textContent=s==='interview'?'面试总结':'会议总结';
  $('#summary').placeholder=s==='interview'?'核心问答记录\n\n初步评价':'会议摘要\n\n关键结论\n\n待办事项\n\n待确认问题';
  $('#summary').setAttribute('aria-label',s==='interview'?'面试总结':'会议总结');
  $('#active-record').textContent=s==='interview'?'返回正在进行的面试':'返回正在进行的会议';
  updateSummaryPreview();
}
function updateSummaryPreview(){ $('#summary-preview').innerHTML=markdown($('#summary').value)||`<p class="muted">转写后将生成${scenarioKind($('#scenario').value)==='interview'?'核心问答记录和初步评价':'会议摘要、关键结论、待办事项及待确认问题'}。</p>`; }
function summaryMode(edit=false){state.editSummary=edit;$('#summary').classList.toggle('hidden',!edit);$('#summary-preview').classList.toggle('hidden',edit);$('#summary-tools').classList.toggle('hidden',!edit);$('#edit-summary').textContent=edit?'查看排版':'编辑总结';updateSummaryPreview();}
const state={token:'',selected:null,live:null,record:null,socket:null,capture:null,summaryDirty:false,boot:null,processing:false,paused:false,resumeResolve:null};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const duration=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const date=s=>new Date(s).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const statuses={recording:'录音中',processing:'转写处理中',complete:'已存档',interrupted:'录音中断',partial:'转写待补全'};
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),6500);}
async function api(url,body){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-App-Token':state.token},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw new Error(result.error||'请求失败');return result;}
function guarded(fn){return async e=>{try{await fn(e);}catch(err){toast(err.message);}};}
function view(name){document.querySelectorAll('.view').forEach(e=>e.classList.toggle('hidden',e.id!==`view-${name}`));document.querySelectorAll('[data-view]').forEach(e=>e.classList.toggle('active',e.dataset.view===name));$('#page-name').textContent={record:'录音工作台',library:'全部记录',assistant:'档案助手',settings:'模型与设置'}[name];if(name==='library')loadLibrary().catch(e=>toast(e.message));}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view));

async function boot(){state.boot=await api('/api/bootstrap');state.token=state.boot.token;fillSettings(state.boot.settings);$('#data-path').textContent=state.boot.dataDir;applyScenarioUI('meeting');recordingControls('idle');connect();await loadLibrary();if(state.boot.active.length){const id=state.boot.active[0],r=await api(`/api/records/${id}`);if(r.status==='recording'){state.live=id;state.paused=!!r.paused;await selectRecord(id);recordingControls(state.paused?'paused':'recording');toast('检测到进行中的录音，请保留原录音页面。');}}}
function fillSettings(s){state.savedSettings=s;for(const k of ['asrUrl','asrModel','llmUrl','llmModel'])$('#settings-form').elements[k].value=s[k];for(const type of ['asr','llm']){const id=identifyProvider(s[type+'Url'],type==='asr');$('#'+type+'-provider').value=id;providerHelp(type,id);}$('#fast-mode').checked=s.fastMode!==false;$('#asr-key-status').textContent=s.asrConfigured?'· 已配置':'';$('#llm-key-status').textContent=s.llmConfigured?'· 已配置':'';if(s.keyWarning)toast('保存的密钥无法由当前 Windows 用户解密，请重新填写密钥。档案仍可访问。');}
function connect(){
  const ws=new WebSocket(`${location.origin.replace('http','ws')}/live?token=${state.token}`);state.socket=ws;
  ws.onopen=guarded(async()=>{if(state.processing && state.live && !state.capture){const r=await api(`/api/records/${state.live}`);if(!['recording','processing'].includes(r.status)){state.processing=false;state.live=null;state.paused=false;recordingControls('idle');await selectRecord(r.id,false);}}});
  ws.onmessage=guarded(async e=>{
    const m=JSON.parse(e.data);
    if(m.type==='title'){if(m.id===state.selected && document.activeElement!==$('#record-title'))$('#record-title').value=m.title;await loadLibrary();}
    if(m.type==='records-changed')await loadLibrary();
    if(m.id===state.live && m.type==='progress')$('#compact-time').textContent=duration(m.duration);
    if(m.id===state.live && m.type==='asr-error')$('#compact-status').textContent='转写异常 · 录音仍保存';
    if(m.type==='error'){toast(m.message);if(state.capture||state.paused)await endRecording(true);return;}
    if(m.type==='started')state.startResolve?.();
    if(m.type==='resumed'){state.resumeResolve?.();state.resumeResolve=null;}
    if(m.type==='asr-error'){if(m.id===state.selected)$('#record-message').textContent=m.message;toast(m.message);}
    if(m.type==='asr-ready' && m.id===state.selected)$('#record-message').textContent=m.message||'转写已连接 · 录音和文字持续保存到本机';
    if(m.type==='segment' && m.id===state.selected){appendSegment(m.segment);$('#partial').textContent='';}
    if(m.type==='partial' && m.id===state.selected)$('#partial').textContent=m.text;
    if(m.type==='progress' && m.id===state.selected){$('#duration').textContent=duration(m.duration);if(m.lag>5)$('#record-message').textContent=`录音已保存 · 转写仍有 ${Math.ceil(m.lag)} 秒音频待处理`;}
    if(m.type==='paused' && m.id===state.selected){state.paused=true;await selectRecord(m.id,false);recordingControls('paused');$('#duration').textContent=duration(m.duration||0);$('#compact-time').textContent=duration(m.duration||0);$('#compact-status').textContent='已暂停';$('#record-state').textContent='已暂停';$('#record-message').textContent='录音已暂停 · 点击“继续录音”接着记录同一条档案';}
    if(m.type==='resumed' && m.id===state.selected){state.paused=false;recordingControls('recording');$('#compact-status').textContent='正在录音';$('#record-state').textContent='正在录音';$('#record-message').textContent='录音已继续 · 继续写入同一条档案';if(m.event)appendEvent(m.event);}
    if(m.type==='processing' && m.id===state.selected){$('#record-state').textContent='正在存档';$('#record-message').textContent=m.message;if((state.capture||state.paused) && m.id===state.live)await endRecording(true);}
    if(m.type==='finished'){
      if(m.id===state.live){state.live=null;state.processing=false;state.paused=false;recordingControls('idle');window.desktop?.recording(false);await expandWindow();}
      if(m.id===state.selected){await selectRecord(m.id,false);$('#record-message').textContent=state.record.warning||'录音与文字已存档，完整总结正在生成。';}
      await loadLibrary();
    }
    if(m.type==='summary-busy' && m.id===state.selected){$('#summary-info').textContent='正在梳理截至当前的内容…';$('#generate-summary').disabled=true;}
    if(m.type==='summary' && m.id===state.selected){const r=await api(`/api/records/${m.id}`);state.record=r;renderSummary(r);$('#generate-summary').disabled=false;}
    if(m.type==='summary-error'){if(m.id===state.selected){$('#summary-info').textContent=m.message;$('#generate-summary').disabled=false;}toast(m.message);}
  });
  ws.onclose=()=>{if(state.capture||state.paused||state.live){state.processing=false;endRecording(true).catch(()=>{});toast('本机服务连接中断，采集已停止。请检查服务后重新开始记录。');}setTimeout(()=>{if(!state.capture&&!state.live)connect();},3000);};
}
function recordingControls(mode='idle'){
  const active=['recording','paused','processing'].includes(mode),controllable=mode==='recording'||mode==='paused';
  $('#start').classList.toggle('hidden',active);$('#pause').classList.toggle('hidden',!controllable);$('#stop').classList.toggle('hidden',!active);
  $('#microphone').disabled=active;$('#refresh-mics').disabled=active;$('#scenario').disabled=active||!!state.selected;
  $('#start').disabled=state.processing;$('#pause').disabled=!controllable;$('#stop').disabled=mode==='processing';
  $('#pause').textContent=mode==='paused'?'▶ 继续录音':'Ⅱ 暂停录音';$('#pause').classList.toggle('primary',mode==='paused');$('#pause').classList.toggle('secondary',mode!=='paused');
  $('#live-dot').classList.toggle('on',active);$('#active-record').classList.toggle('hidden',!active);$('#record-state').classList.toggle('recording',active);
  if(mode==='paused')$('#record-state').textContent='已暂停';else if(mode==='recording')$('#record-state').textContent='正在录音';
}
async function refreshMics(){const stream=await navigator.mediaDevices.getUserMedia({audio:true});try{const devices=await navigator.mediaDevices.enumerateDevices();$('#microphone').innerHTML='<option value="">系统默认麦克风</option>'+devices.filter(d=>d.kind==='audioinput' && d.deviceId!=='default').map((d,i)=>`<option value="${esc(d.deviceId)}">${esc(d.label||`麦克风 ${i+1}`)}</option>`).join('');}finally{stream.getTracks().forEach(t=>t.stop());}}
$('#refresh-mics').onclick=guarded(refreshMics);
$('#new-record').onclick=guarded(async()=>{
  if(state.live){await selectRecord(state.live);return;}
  if(state.summaryDirty && !confirm('当前总结有未保存的编辑，确定离开吗？'))return;
  state.selected=null;state.record=null;state.summaryDirty=false;state.paused=false;applyScenarioUI('meeting');recordingControls('idle');view('record');$('#record-title').value='';$('#duration').textContent='00:00';$('#record-state').textContent='准备就绪';$('#record-message').textContent='首次使用请先配置模型。也可以先录音，再补转写。';$('#transcript').innerHTML='<div class="empty"><div class="empty-symbol">≋</div><h3>从一句话开始</h3><p>开始录音后，文字会实时出现在这里。</p></div>';$('#summary').value='';summaryMode(false);$('#summary').disabled=true;$('#save-summary').disabled=true;$('#generate-summary').disabled=true;$('#metadata').classList.add('hidden');$('#export-docx').classList.add('hidden');$('#audio-wrap').classList.add('hidden');$('#summary-history').innerHTML='';$('#segment-count').textContent='0';$('#partial').textContent='';$('#summary-info').textContent='每 10 分钟梳理一次，结束后生成完整总结。';
});
$('#active-record').onclick=guarded(()=>selectRecord(state.live));
async function attachCapture(){
  if(state.socket?.readyState!==WebSocket.OPEN)throw new Error('本机服务尚未连接，请稍后再试。');
  const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:$('#microphone').value?{exact:$('#microphone').value}:undefined,channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
  const ctx=new AudioContext();
  try{
    await ctx.audioWorklet.addModule('/pcm-worklet.js');await ctx.resume();
    const node=new AudioWorkletNode(ctx,'pcm-recorder'),source=ctx.createMediaStreamSource(stream),mute=ctx.createGain();mute.gain.value=0;
    const capture={stream,ctx,node,source,mute};state.capture=capture;
    node.port.onmessage=e=>{
      if(e.data.stopped){state.flushResolve?.();return;}
      if(e.data.pcm && state.socket?.readyState===WebSocket.OPEN){
        if(state.socket.bufferedAmount>1024*1024){toast('本机传输积压，录音已停止以避免丢失更多数据。');endRecording(true).catch(()=>{});return;}
        state.socket.send(e.data.pcm);const pcm=new Int16Array(e.data.pcm);let peak=0;for(const x of pcm)peak=Math.max(peak,Math.abs(x));$('#level').classList.toggle('on',peak>300);
      }
    };
    source.connect(node);node.connect(mute);mute.connect(ctx.destination);
    stream.getAudioTracks()[0].onended=()=>{toast('麦克风已断开，正在保存已录内容。');endRecording(true).catch(()=>{});};
    ctx.onstatechange=()=>{if(ctx.state==='suspended' && state.capture){toast('音频采集被系统暂停，正在保存记录。');endRecording(true).catch(()=>{});}};
    try{state.wakeLock=await navigator.wakeLock?.request('screen');}catch{}
    return capture;
  }catch(error){
    if(state.capture?.ctx===ctx)state.capture=null;
    stream.getTracks().forEach(t=>t.stop());await ctx.close().catch(()=>{});throw error;
  }
}
async function detachCapture(flush=true){
  const capture=state.capture;if(!capture)return;state.capture=null;
  try{
    if(flush)await new Promise(resolve=>{const timer=setTimeout(resolve,1500);state.flushResolve=()=>{clearTimeout(timer);resolve();};capture.node.port.postMessage('stop');});
  }finally{
    state.flushResolve=null;
    capture.stream.getTracks().forEach(t=>{t.onended=null;t.stop();});
    await capture.ctx.close().catch(()=>{});
    try{await state.wakeLock?.release();}catch{}
    state.wakeLock=null;
  }
}
const captureError=e=>new Error(e?.name==='NotAllowedError'?'未获得麦克风权限，请在浏览器地址栏允许麦克风。':e?.message||'录音设备启动失败');
$('#start').onclick=guarded(async()=>{
  if(state.live || state.processing)return;
  if(state.summaryDirty && !confirm('当前总结有未保存的修改，确定新建录音吗？'))return;
  if(state.socket?.readyState!==WebSocket.OPEN)throw new Error('本机服务尚未连接，请稍后再试。');
  $('#start').disabled=true;
  try{
    const title=state.selected?'':$('#record-title').value.trim();
    const r=await api('/api/records',{title,scenario:$('#scenario').value});state.live=r.id;state.selected=r.id;state.record=r;state.summaryDirty=false;state.paused=false;state.segmentIds=new Set();
    const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{state.startResolve=null;reject(new Error('启动录音超时'));},10000);state.startResolve=()=>{clearTimeout(timer);state.startResolve=null;resolve();};});
    state.socket.send(JSON.stringify({type:'start',id:r.id}));await ready;
    await attachCapture();recordingControls('recording');await selectRecord(r.id,false);$('#record-state').textContent='正在录音';$('#record-message').textContent='电脑麦克风正在采集 · 正在连接转写服务';
    window.desktop?.recording(true);if(window.desktop)await compactWindow();
  }catch(e){if(state.live && state.socket?.readyState===WebSocket.OPEN)state.socket.send(JSON.stringify({type:'interrupt'}));await detachCapture(false);state.capture=null;state.live=null;state.paused=false;state.processing=false;recordingControls('idle');throw captureError(e);}
  finally{$('#start').disabled=state.processing;}
});
async function endRecording(interrupted=false){
  if(state.processing||!state.live)return;
  state.processing=true;state.paused=false;recordingControls('processing');
  await detachCapture(true);
  if(state.socket?.readyState===WebSocket.OPEN)state.socket.send(JSON.stringify({type:interrupted?'interrupt':'stop'}));
  else{state.processing=false;state.live=null;window.desktop?.recording(false);await expandWindow();recordingControls('idle');}
  $('#level').classList.remove('on');$('#record-state').textContent='正在存档';$('#record-message').textContent='音频已停止采集，正在等待剩余转写。';
}
async function pauseRecording(){
  if(!state.capture||state.paused||state.processing)return;
  $('#pause').disabled=true;
  try{
    await detachCapture(true);
    if(state.socket?.readyState!==WebSocket.OPEN)throw new Error('本机服务连接中断，无法暂停录音。');
    state.paused=true;state.socket.send(JSON.stringify({type:'pause'}));recordingControls('paused');
    $('#record-state').textContent='已暂停';$('#record-message').textContent='录音已暂停 · 点击“继续录音”接着记录同一条档案';$('#compact-status').textContent='已暂停';
  }catch(e){state.paused=false;toast(e.message);await endRecording(true);}
  finally{$('#pause').disabled=false;}
}
async function resumeRecording(){
  if(!state.paused||state.processing)return;
  $('#pause').disabled=true;
  try{
    if(state.socket?.readyState!==WebSocket.OPEN)throw new Error('本机服务连接中断，无法继续录音。');
    const resumed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{state.resumeResolve=null;reject(new Error('继续录音超时'));},10000);state.resumeResolve=()=>{clearTimeout(timer);state.resumeResolve=null;resolve();};});
    state.socket.send(JSON.stringify({type:'resume'}));await resumed;
    await attachCapture();state.paused=false;recordingControls('recording');$('#compact-status').textContent='正在录音';$('#record-state').textContent='正在录音';$('#record-message').textContent='录音已继续 · 继续写入同一条档案';
  }catch(e){toast(e.message);await endRecording(true);}
  finally{$('#pause').disabled=false;}
}
$('#pause').onclick=guarded(()=>state.paused?resumeRecording():pauseRecording());
$('#stop').onclick=guarded(()=>endRecording());
window.addEventListener('beforeunload',e=>{if(state.capture||state.live||state.summaryDirty){e.preventDefault();e.returnValue='';}});

function appendSegment(s){
  state.segmentIds??=new Set();if(state.segmentIds.has(s.id))return;state.segmentIds.add(s.id);
  const target=$('#transcript');if(target.querySelector('.empty'))target.innerHTML='';
  const el=document.createElement('div');el.className='segment'+(s.text!==s.original?' edited':'');el.dataset.sid=s.id;
  const btn=document.createElement('button');btn.className='segment-time';btn.textContent=duration(s.start);btn.onclick=guarded(()=>playAt(s.start));
  const text=document.createElement('textarea');text.value=s.text;text.setAttribute('aria-label',`转写 ${duration(s.start)}`);text.rows=Math.max(1,Math.ceil(s.text.length/30));
  const rid=state.selected;text.onchange=guarded(async()=>{await api(`/api/records/${rid}/segments`,{id:s.id,text:text.value});el.classList.add('edited');toast('转写修订已保存；需要时可重新生成总结。');});
  el.append(btn,text);target.append(el);$('#segment-count').textContent=state.segmentIds.size;
  if(state.live===state.selected)target.scrollTop=target.scrollHeight;
}
function appendEvent(e){
  if(!e)return;const target=$('#transcript');if(target.querySelector('.empty'))target.innerHTML='';
  if(e.id && target.querySelector(`[data-eid="${e.id}"]`))return;
  const el=document.createElement('div');el.className='recording-event';if(e.id)el.dataset.eid=e.id;
  el.textContent=`— ${e.kind==='pause'?'已暂停':'已继续'} ${new Date(e.created).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})} —`;
  target.append(el);if(state.live===state.selected)target.scrollTop=target.scrollHeight;
}
async function selectRecord(id,navigate=true){
  if(!id)return;if(id!==state.selected && state.summaryDirty && !confirm('总结有未保存的修改，确定离开吗？'))return false;
  const same=id===state.selected,r=await api(`/api/records/${id}`);state.selected=id;state.record=r;if(!same)state.summaryDirty=false;
  applyScenarioUI(r.scenario);$('#scenario').disabled=true;$('#meta-scenario').disabled=r.status==='recording'||r.status==='processing';
  if(navigate)view('record');$('#record-title').value=r.title;$('#record-state').textContent=statuses[r.status]||r.status;$('#duration').textContent=duration(r.duration);$('#record-message').textContent=r.warning||'录音和转写文字保存在本机';
  state.segmentIds=new Set();$('#transcript').innerHTML='';
  const timeline=[
    ...r.segments.map(s=>({order:0,at:s.start,type:'segment',value:s})),
    ...(r.events||[]).map(e=>({order:1,at:e.audio_at,type:'event',value:e})),
  ].sort((a,b)=>a.at-b.at||a.order-b.order);
  for(const item of timeline)item.type==='event'?appendEvent(item.value):appendSegment(item.value);
  $('#segment-count').textContent=r.segments.length;
  if(!r.segments.length && !(r.events||[]).length)$('#transcript').innerHTML='<div class="empty"><div class="empty-symbol">≋</div><h3>等待转写内容</h3><p>录音期间实时出字，已保存的录音也可稍后补转写。</p></div>';
  $('#summary').disabled=false;$('#save-summary').disabled=false;$('#generate-summary').disabled=false;renderSummary(r);
  $('#metadata').classList.remove('hidden');$('#meta-participants').value=r.participants;$('#export').href=`/api/records/${id}/export`;
  $('#retry').disabled=r.status==='recording'||r.status==='processing';
  if(r.status!=='recording'){$('#audio-wrap').classList.remove('hidden');const url=`/api/records/${id}/audio`;if($('#audio').getAttribute('src')!==url){$('#audio').src=url;$('#audio').load();}}else $('#audio-wrap').classList.add('hidden');
  return true;
}
function renderSummary(r){
  updateExportLinks(r);
  const latest=r.summaries.find(s=>s.kind!=='manual');
  if(!state.summaryDirty)$('#summary').value=r.manual_summary??latest?.body??'';
  updateSummaryPreview();
  $('#summary-info').textContent=state.summaryDirty?'有未保存的编辑，自动总结已保留到历史版本。':r.manual_summary!==null?'当前显示人工编辑版；新的自动总结在历史版本中查看。':latest?`更新于 ${date(latest.created)} · 覆盖至 ${duration(latest.through)}`:'每 10 分钟梳理一次，结束后生成完整总结。';
  $('#summary-history').innerHTML='';
  for(const s of r.summaries){const el=document.createElement('div');el.className='history-item';const head=document.createElement('div');head.textContent=`${date(s.created)} · ${{manual:'人工保存',auto:'阶段总结',final:'完整总结'}[s.kind]} · ${duration(s.through)}`;const pre=document.createElement('div');pre.className='markdown history-body';pre.innerHTML=markdown(s.body);const use=document.createElement('button');use.className='text-button';use.textContent='载入编辑区';use.onclick=()=>{if(state.summaryDirty&&!confirm('替换当前尚未保存的编辑？'))return;$('#summary').value=s.body;state.summaryDirty=true;summaryMode(true);$('#summary-save-state').textContent='尚未保存';};el.append(head,pre,use);$('#summary-history').append(el);}
}
function updateExportLinks(r){
  const hasSummary=Boolean(r.manual_summary ?? r.summaries.find(s=>s.kind!=='manual')?.body);
  $('#export').href=`/api/records/${r.id}/export`;
  $('#export-docx').href=`/api/records/${r.id}/export-docx`;
  $('#export-docx').classList.toggle('hidden',r.scenario!=='interview'||!hasSummary);
}
async function playAt(seconds){const a=$('#audio');const src=`/api/records/${state.selected}/audio`;$('#audio-wrap').classList.remove('hidden');if(a.getAttribute('src')!==src){a.src=src;a.load();}if(a.readyState<1)await new Promise((resolve,reject)=>{a.addEventListener('loadedmetadata',resolve,{once:true});a.addEventListener('error',()=>reject(new Error('录音暂时无法播放')),{once:true});});a.currentTime=seconds;await a.play();}
$('#summary').oninput=()=>{state.summaryDirty=true;$('#summary-save-state').textContent='尚未保存';};
$('#save-summary').onclick=guarded(async()=>{const id=state.selected;const value=$('#summary').value;const r=await api(`/api/records/${id}`,{manual_summary:value});if(state.selected===id && $('#summary').value===value){state.summaryDirty=false;state.record=r;renderSummary(r);$('#summary-save-state').textContent='人工版本已保存';}toast('总结编辑已保存');});
$('#generate-summary').onclick=guarded(async()=>{await api(`/api/records/${state.selected}/summary`,{});toast('已开始生成新版本，人工编辑会保留。');});
$('#save-meta').onclick=guarded(async()=>{await api(`/api/records/${state.selected}`,{participants:$('#meta-participants').value});toast('参与人已保存');await loadLibrary();});
$('#scenario').onchange=()=>applyScenarioUI($('#scenario').value);
$('#meta-scenario').onchange=guarded(async()=>{
  const id=state.selected;if(!id)return;
  const r=await api(`/api/records/${id}`,{scenario:$('#meta-scenario').value});state.record=r;applyScenarioUI(r.scenario);updateExportLinks(r);$('#meta-scenario').disabled=r.status==='recording'||r.status==='processing';
  toast('听记场景已更新');await loadLibrary();
  if(r.segments.length && confirm('场景已更新，是否立即按新场景重新生成总结？'))await api(`/api/records/${id}/summary`,{});
});
$('#record-title').onchange=guarded(async()=>{if(state.selected && $('#record-title').value.trim())await api(`/api/records/${state.selected}`,{title:$('#record-title').value.trim()});});
$('#auto-title').onclick=guarded(async()=>{if(!state.selected)throw new Error('开始录音后会自动生成标题');await api(`/api/records/${state.selected}/title`,{});toast('正在提炼标题');});
$('#edit-summary').onclick=()=>summaryMode(!state.editSummary);
document.querySelectorAll('[data-format]').forEach(button=>button.onclick=()=>{const field=$('#summary'),start=field.selectionStart,end=field.selectionEnd;const selected=field.value.slice(start,end);const value=button.dataset.format==='bold'?`**${selected||'重点内容'}**`:`\n## ${selected||'标题'}\n`;field.setRangeText(value,start,end,'select');field.dispatchEvent(new Event('input'));field.focus();});
$('#retry').onclick=guarded(async()=>{await api(`/api/records/${state.selected}/retry`,{});$('#retry').disabled=true;$('#record-message').textContent='正在从已确认文字之后补转写，耗时与剩余录音长度接近。';});

async function loadLibrary(){
  const all=await api('/api/records');$('#record-count').textContent=all.length;
  const trash=$('#show-trash').checked;
  const params=new URLSearchParams({q:$('#search-q').value,from:$('#search-from').value,to:$('#search-to').value,trash:String(trash)});
  const records=await api('/api/records?'+params),target=$('#library-results');target.innerHTML='';
  if(!records.length){target.innerHTML=`<div class="panel empty"><div class="empty-symbol">▤</div><h3>${trash?'回收站是空的':'没有匹配的记录'}</h3><p>可调整搜索条件或开始一次新录音。</p></div>`;return;}
  for(const r of records){
    const card=document.createElement('article');card.className='panel record-item';
    const open=document.createElement('button');open.className='record-open';open.disabled=trash;
    open.innerHTML=`<div class="record-topline"><span class="date">${esc(date(r.created))}</span><span class="scenario-tag ${r.scenario==='interview'?'interview':''}">${scenarioName(r.scenario)}</span></div><h2>${esc(r.title)}</h2><p>${esc(r.participants||'未填写参与人')}</p><div class="record-foot"><span>${duration(r.duration)} · ${r.segment_count} 段原文</span><span>${esc(statuses[r.status])} ↗</span></div>`;
    open.onclick=guarded(()=>selectRecord(r.id));
    const remove=document.createElement('button');remove.className='text-button delete-record';remove.textContent=trash?'恢复记录':'删除';
    remove.onclick=guarded(async()=>{
      if(!trash && !confirm(`将“${r.title}”移入回收站？之后可恢复。`))return;
      if(!trash && state.selected===r.id && state.summaryDirty && !confirm('总结还有未保存的编辑，仍然删除吗？'))return;
      await api(`/api/records/${r.id}/${trash?'restore':'delete'}`,{});
      if(!trash && state.selected===r.id){$('#audio').pause();state.summaryDirty=false;$('#new-record').click();view('library');}
      toast(trash?'记录已恢复':'已移入回收站，助手检索将排除这条记录');await loadLibrary();
    });card.append(open,remove);target.append(card);
  }
}
$('#show-trash').onchange=guarded(loadLibrary);
$('#search-form').onsubmit=guarded(async e=>{e.preventDefault();if($('#search-from').value && $('#search-to').value && $('#search-from').value>$('#search-to').value)throw new Error('起始日期不能晚于结束日期');await loadLibrary();});
document.querySelectorAll('.suggestions button').forEach(b=>b.onclick=()=>{$('#question').value=b.textContent;$('#question').focus();});
$('#ask-form').onsubmit=guarded(async e=>{
  e.preventDefault();const question=$('#question').value.trim();if(!question)return;const chat=$('#chat');chat.querySelector('.assistant-welcome')?.remove();
  const q=document.createElement('div');q.className='chat-question';q.textContent=question;const answer=document.createElement('div');answer.className='chat-answer';answer.textContent='正在检索原文并整理回答…';chat.append(q,answer);$('#ask-button').disabled=true;$('#question').value='';chat.scrollTop=chat.scrollHeight;
  const began=performance.now();
  try{const result=await api('/api/ask',{question,filters:{from:$('#ask-from').value,to:$('#ask-to').value}});answer.classList.add('markdown');answer.innerHTML=markdown(result.answer);
    const coverage=document.createElement('div');coverage.className='coverage';coverage.textContent=(result.filters?.from||result.filters?.to?`检索日期：${result.filters.from||'不限'} 至 ${result.filters.to||'不限'}。 `:'')+(result.truncated?`找到 ${result.matched} 个候选片段，受上下文长度限制，仅使用其中部分；建议缩小范围复核。`:'回答基于检索到的原文片段；引用文字可点击核对。');chat.append(coverage);
    for(const s of result.sources){const b=document.createElement('button');b.className='source-button';b.textContent=`[${s.label}] ${s.title} · ${scenarioName(s.scenario)} · ${date(s.created)} · ${duration(s.start)}\n${s.text}`;b.onclick=guarded(async()=>{if(await selectRecord(s.record_id)){const el=$(`[data-sid="${s.id}"]`);el?.classList.add('highlight');el?.scrollIntoView({block:'center'});await playAt(s.start);}});chat.append(b);}
  }catch(err){answer.textContent=err.message;}finally{$('#ask-button').disabled=false;$('#answer-timing').textContent=`本次耗时 ${((performance.now()-began)/1000).toFixed(1)} 秒`;chat.scrollTop=chat.scrollHeight;}
});
$('#settings-form').onsubmit=guarded(async e=>{e.preventDefault();const values={...Object.fromEntries(new FormData(e.target)),fastMode:$('#fast-mode').checked};const s=await api('/api/settings',values);fillSettings(s);e.target.elements.asrKey.value='';e.target.elements.llmKey.value='';$('#settings-status').textContent='模型设置已保存';toast('模型设置已保存');});
$('#test-model').onclick=guarded(async()=>{$('#test-model').disabled=true;$('#settings-status').textContent='连接测试中…';try{await api('/api/settings/test',{});$('#settings-status').textContent='语言模型连接成功';}catch(e){$('#settings-status').textContent=e.message;throw e;}finally{$('#test-model').disabled=false;}});
async function compactWindow(){if(!window.desktop){toast('跨应用悬浮窗请通过“启动桌面版.cmd”使用。');return;}$('#compact-status').textContent=state.paused?'已暂停':state.capture?'正在录音':state.processing?'正在存档':'双击展开工作台';$('#compact-stop').disabled=!state.live;document.body.classList.add('compact');try{await window.desktop.compact();}catch(e){document.body.classList.remove('compact');throw e;}}
async function expandWindow(){document.body.classList.remove('compact');await window.desktop?.expand();}
$('#compact-expand').ondblclick=guarded(expandWindow);
$('#compact-stop').onclick=guarded(()=>endRecording());
$('#float-window').onclick=guarded(compactWindow);
$('#desktop-minimize').onclick=()=>window.desktop?.minimize();
$('#desktop-close').onclick=()=>{if(state.capture||state.live||state.processing||state.summaryDirty){toast('请先结束录音并保存编辑，再关闭窗口。');return;}window.desktop?.close();};
if(window.desktop)document.body.classList.add('desktop');
function providerHelp(type,id){
  const p=(type==='asr'?speechProviders:languageProviders)[id];
  $('#'+type+'-provider-help').textContent=p?.help||'保留现有自定义配置。';
  $('#'+type+'-models').innerHTML=(p?.models||[]).map(m=>`<option value="${esc(m)}"></option>`).join('');
}
for(const type of ['asr','llm']){
  const catalog=type==='asr'?{...speechProviders,custom:{name:'现有/自定义 WebSocket 配置',url:'',models:[],help:'仅兼容百炼 inference 协议。'}}:languageProviders;
  $('#'+type+'-provider').innerHTML=Object.entries(catalog).map(([id,p])=>`<option value="${id}">${esc(p.name)}</option>`).join('');
  $('#'+type+'-provider').onchange=()=>{
    const id=$('#'+type+'-provider').value,p=catalog[id],form=$('#settings-form').elements;
    if(p.url){form[type+'Url'].value=p.url;form[type+'Model'].value=p.models[0];}
    form[type+'Key'].value='';providerHelp(type,id);
    $('#'+type+'-key-status').textContent='· 切换地址时请填写对应 Key';
    $('#settings-status').textContent='配置尚未保存';
  };
}
summaryMode(false);
boot().catch(e=>toast('启动失败：'+e.message));
