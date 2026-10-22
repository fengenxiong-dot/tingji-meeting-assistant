const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{
  compact:()=>ipcRenderer.invoke('window:compact'),expand:()=>ipcRenderer.invoke('window:expand'),
  recording:value=>ipcRenderer.send('window:recording',value===true),
  minimize:()=>ipcRenderer.send('window:minimize'),close:()=>ipcRenderer.send('window:close'),
});
