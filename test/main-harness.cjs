const fs=require('fs'),path=require('path'),vm=require('vm');
function harness(){
 const handlers=new Map();const messages=[];
 class Window{constructor(){this.webContents={send:(...a)=>messages.push(a)};}isDestroyed(){return false}close(){}loadFile(file){this.file=file}}
 const electron={app:{getPath:()=>'/tmp/session-pets-test-data',whenReady:()=>({then(){}}),on(){}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}},screen:{},dialog:{},Tray:class{},Menu:{},nativeImage:{}};
 const context=vm.createContext({require:name=>name==='electron'?electron:require(name.startsWith('./')?path.join(__dirname,'..',name):name),__dirname:path.join(__dirname,'..'),console,process,Buffer,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),context);
 return {handlers,messages,context,codex:vm.runInContext('codex',context)};
}
module.exports={harness};
