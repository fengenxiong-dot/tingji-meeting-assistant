const {execFileSync}=require('node:child_process');
console.log(execFileSync(require('electron'),['-e',"console.log(process.versions.node); console.log(!!require('node:sqlite').DatabaseSync)"],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true}));
