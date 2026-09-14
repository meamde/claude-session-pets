const {contextBridge,ipcRenderer}=require('electron');
const noop=()=>{}, row=(id,provider)=>({id:provider+':'+id,provider,sessionId:id,sessionName:provider+' demo',cwd:'/tmp/shared-project',pid:provider==='claude'?100: null,cpu:0,cpusec:0,etime:'01:00',state:'working',task:'같은 폴더의 독립된 세션 테스트',hookState:'working',hookAge:0,transport:'desktop'});
let rows=[row('11111111-1111-1111-1111-111111111111','claude'),row('22222222-2222-2222-2222-222222222222','codex'),row('33333333-3333-3333-3333-333333333333','codex')];
contextBridge.exposeInMainWorld('smoke',{setRows:v=>{rows=v}});
contextBridge.exposeInMainWorld('pet',{
 setIgnoreMouse:noop,quit:noop,getHome:async()=>'/tmp',getSavedImage:async()=>null,getSessionImage:async()=>null,onImageChanged:noop,onWorkAreaChanged:noop,onRunOutput:noop,onRunDone:noop,
 listSessions:async()=>rows,listInjectableTtys:async()=>[],listForms:async()=>[],getUsage:async(force,provider)=>provider==='codex'?{session:{pct:20,minutes:300},weekAll:{pct:30,minutes:10080},windows:[{name:'Codex · 5시간',pct:20,resets:'tomorrow'}]}:{session:{pct:10,resets:'today'},weekAll:{pct:20,resets:'tomorrow'},weeks:[],spans:[]},
 focusAgentSession:async()=>({ok:true}),focusSession:async()=>({ok:true}),openFolder:async()=>({ok:true}),saveSessionImage:async()=>{},deleteSessionImage:async()=>{},codexFormMode:async()=>({ok:true,on:true}),pickImage:async()=>null,
});
