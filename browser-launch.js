import { createApp } from './server.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=process.env.TINGJI_PORT===undefined?4317:Number(process.env.TINGJI_PORT);
let app;
function openBrowser(url){
  console.log(`\n听记君已就绪：${url}\n请在 Edge / Chrome 打开以上地址，允许麦克风。\n录音期间请保留本窗口和网页；结束并存档后再退出。`);
  if(process.env.TINGJI_NO_BROWSER==='1')return;
  const child=spawn('cmd.exe',['/d','/c','start','',url],{windowsHide:true,stdio:'ignore'});
  child.on('error',()=>console.log('自动打开浏览器失败，请手动复制上面的地址。'));
}
try{
  let existing;
  if(port)try{existing=await fetch(`http://127.0.0.1:${port}/api/bootstrap`,{signal:AbortSignal.timeout(1500)}).then(r=>r.json());}catch{}
  if(existing){
    if(existing.appId!=='tingjijun'||!existing.features?.includes('providers'))throw new Error('端口上已有其他程序或旧版听记君，请先退出旧版再启动。');
    console.log('已有听记君服务在运行，将打开现有服务。数据目录：'+existing.dataDir);
    openBrowser(`http://127.0.0.1:${port}`);
  }else{
    app=createApp({dataDir:process.env.TINGJI_DATA_DIR||path.join(root,'data')});
    const url=await app.listen(port);
    console.log('数据目录：'+app.store.dir);
    openBrowser(url);
    for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await app.close();process.exit();});
  }
}catch(error){
  console.error('启动失败：'+(error.code==='EADDRINUSE'?'本机端口被占用，请退出旧版或请 IT 检查。':error.message));
  console.error('请保留本窗口的错误信息，录音和档案不会被删除。');
  process.exitCode=1;
}
