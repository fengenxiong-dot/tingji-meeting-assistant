const {app,BrowserWindow,ipcMain,screen,session,dialog,powerSaveBlocker}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
let win,backend,origin,normalBounds,compact=false,recording=false,powerId;
if(!app.requestSingleInstanceLock()){app.quit();}else{
app.on('second-instance',()=>{if(win){win.restore();win.focus();}});
app.whenReady().then(async()=>{
  app.setName('听记君');
  const configPath=path.join(app.getPath('userData'),'archive-location.json');
  let savedDir;try{savedDir=JSON.parse(fs.readFileSync(configPath,'utf8')).dataDir;}catch{}
  try{
    const existing=await fetch('http://127.0.0.1:4317/api/bootstrap',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
    if(existing.appId==='tingjijun' && existing.version==='0.2.1' && existing.features?.includes('providers')){
      origin='http://127.0.0.1:4317';savedDir=existing.dataDir;
      fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.writeFileSync(configPath,JSON.stringify({dataDir:savedDir}));
    }
  }catch{}
  if(!origin){
    const {createApp}=await import('../server.js');
    const dataDir=process.env.TINGJI_DATA_DIR||savedDir||(app.isPackaged?path.join(app.getPath('userData'),'data'):path.join(__dirname,'..','data'));
    backend=createApp({dataDir});origin=await backend.listen(4317);
  }
  const trusted=url=>{try{return new URL(url).origin===origin;}catch{return false;}};
  // This renderer only loads our loopback UI; do not route local traffic through a corporate proxy.
  await session.defaultSession.setProxy({mode:'direct'});
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(trusted(contents.getURL()) && (permission==='media' && !details.mediaTypes?.includes('video'))));
  session.defaultSession.setPermissionCheckHandler((contents,permission,requestingOrigin,details)=>trusted(requestingOrigin) && permission==='media' && details.mediaType!=='video');
  win=new BrowserWindow({width:1280,height:850,minWidth:800,minHeight:600,frame:false,backgroundColor:'#f6f7f3',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!trusted(url))event.preventDefault();});
  win.on('close',event=>{if(recording){event.preventDefault();dialog.showMessageBox(win,{message:'请先结束录音并等待存档完成，再退出听记君。',type:'info'});}});
  const check=event=>{if(event.sender!==win.webContents || !trusted(event.senderFrame?.url))throw new Error('拒绝非应用窗口操作');};
  function expand(){if(!compact)return;compact=false;win.setAlwaysOnTop(false);win.setResizable(true);win.setMinimumSize(800,600);win.setBounds(normalBounds);win.show();}
  ipcMain.handle('window:compact',event=>{
    check(event);if(compact)return;
    normalBounds=win.getBounds();if(win.isMaximized())win.unmaximize();
    const area=screen.getDisplayMatching(normalBounds).workArea;
    compact=true;win.setMinimumSize(300,80);win.setResizable(false);win.setBounds({x:area.x+area.width-330,y:area.y+30,width:310,height:80});win.setAlwaysOnTop(true,'floating');
  });
  ipcMain.handle('window:expand',event=>{check(event);expand();});
  ipcMain.on('window:recording',(event,value)=>{check(event);recording=value===true;if(recording && powerId===undefined)powerId=powerSaveBlocker.start('prevent-app-suspension');if(!recording && powerId!==undefined){powerSaveBlocker.stop(powerId);powerId=undefined;}});
  ipcMain.on('window:minimize',event=>{check(event);win.minimize();});
  ipcMain.on('window:close',event=>{check(event);win.close();});
  await win.loadURL(origin);win.show();
}).catch(error=>{dialog.showErrorBox('听记君启动失败',error.code==='EADDRINUSE'?'检测到旧版服务占用4317端口，请先退出旧服务再启动桌面版。':`${error.message}\n\n如果是 ERR_FAILED：窗口未能加载本机服务，不代表安装失败。可使用 BAT 浏览器版；若浏览器也打不开本机地址，请将错误交给 IT 检查本机连接策略。`);app.quit();});
app.on('window-all-closed',async()=>{if(backend)await backend.close();app.quit();});
}
