const test = require('node:test'), assert = require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const {parseRollout,label}=require('../lib/codex');
const {applyPatches,DesktopIPC}=require('../lib/codex-ipc');
const id='11111111-1111-1111-1111-111111111111';
const event=payload=>JSON.stringify({type:'event_msg',payload});
test('task boundaries tolerate incomplete records and distinguish interruption',()=>{
 const text=event({type:'task_started',turn_id:'t1'})+'\n'+event({type:'item_completed',item:{type:'AgentMessage',phase:'commentary'}});
 assert.equal(parseRollout('{partial\n'+text+'\n{unfinished').state,'working');
 assert.equal(parseRollout(text+'\n'+event({type:'task_complete'})).state,'idle');
 assert.equal(parseRollout(event({type:'turn_aborted'})).completed,false);
});
test('Codex task labels',()=>{assert.equal(label('exec_command','{"cmd":"npm test"}'),'npm test');assert.equal(label('apply_patch','*** Update File: src/main.js\n'),'main.js 수정 중');assert.equal(label('write_stdin',{}),null)});
test('stream patches reject prototype pollution',()=>{
 const state={items:[1,2],status:'idle'};applyPatches(state,[{op:'replace',path:['status'],value:'working'},{op:'remove',path:['items',0]}]);assert.deepEqual(state,{items:[2],status:'working'});
 assert.throws(()=>applyPatches({},[{op:'add',path:['__proto__','polluted'],value:true}]));assert.equal({}.polluted,undefined);
});
test('stream sequence gaps trigger resynchronization',()=>{
 const c=new DesktopIPC('/tmp'),messages=[];c.clientId='test';c.write=m=>messages.push(m);
 const receive=change=>c.receive({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:id,change}});
 receive({type:'snapshot',revision:1,conversationState:{id,status:'idle'}});receive({type:'patches',baseRevision:1,revision:2,patches:[{op:'replace',path:['status'],value:'waiting'}]});assert.equal(c.states.get(id).state.status,'waiting');
 receive({type:'patches',baseRevision:9,revision:10,patches:[]});assert.equal(messages.at(-1).params.following,true);
});
test('messages route by ID, distinguish active turns and reject approval input',async()=>{
 const c=new DesktopIPC('/tmp');c.connect=async()=>{};const calls=[];c.states.set(id,{owner:'owner',state:{threadRuntimeStatus:{type:'idle'},requests:[]}});c.request=async(...a)=>{calls.push(a);return {}};
 await c.send(id,'hello');assert.equal(calls[0][1].turnStart.request.threadId,id);
 c.states.get(id).state.threadRuntimeStatus={type:'active',activeFlags:[]};await c.send(id,'next');assert.equal(calls[1][0],'thread-follower-steer-turn');
 c.states.get(id).state.requests=[{id:'approval'}];await assert.rejects(c.send(id,'yes'));assert.equal(calls.length,2);
 c.states.get(id).state.requests=[];c.request=async()=>{throw Error('timeout')};await assert.rejects(c.send(id,'once'),/timeout/);
});
test('Python hooks: approval, resume, compaction, stop and end',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'pets-hooks-')),file=path.join(home,'session-pets-status',id+'.json');
 const run=(ev,extra={})=>{const r=spawnSync('python3',[path.join(__dirname,'../lib/codex-hook.py')],{input:JSON.stringify({session_id:id,cwd:home,hook_event_name:ev,...extra}),env:{...process.env,CODEX_HOME:home}});assert.equal(r.status,0);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null};
 assert.equal(run('UserPromptSubmit',{prompt:'test'}).state,'working');assert.equal(run('PreToolUse',{tool_name:'Bash',tool_input:{command:'npm test'}}).task,'npm test');assert.equal(run('PermissionRequest').state,'waiting');assert.equal(run('PostToolUse').state,'working');assert.equal(run('SessionStart',{source:'compact'}).state,'working');assert.equal(run('Interrupt').state,'idle');assert.equal(run('Stop').task,undefined);assert.equal(run('SessionEnd'),null);
});
test('hook install preserves other hooks, is idempotent and rejects broken settings',()=>{
 const old=process.env.CODEX_HOME,home=fs.mkdtempSync(path.join(os.tmpdir(),'pets-install-'));process.env.CODEX_HOME=home;const hooks=require('../lib/codex-hooks'),file=path.join(home,'hooks.json');
 try{fs.writeFileSync(file,JSON.stringify({hooks:{Stop:[{hooks:[{command:'existing-hook'}]}]}}));hooks.install();hooks.install();assert.equal(JSON.parse(fs.readFileSync(file)).hooks.Stop.length,2);assert.ok(hooks.installed());assert.equal(hooks.toggle(id),true);assert.equal(hooks.toggle(id),false);fs.writeFileSync(file,'{bad');assert.throws(()=>hooks.install());assert.equal(fs.readFileSync(file,'utf8'),'{bad');}finally{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;}
});
test('hook reinstall preserves mixed groups and validates before changing helper',()=>{
 const old=process.env.CODEX_HOME,home=fs.mkdtempSync(path.join(os.tmpdir(),'pets-mixed-'));process.env.CODEX_HOME=home;
 const hooks=require('../lib/codex-hooks'),file=path.join(home,'hooks.json'),helper=path.join(home,'session-pets-hook.py');
 try {
  fs.writeFileSync(file,JSON.stringify({hooks:{Stop:[{matcher:'*',hooks:[{command:'keep-me'},{command:'python3 session-pets-hook.py'}]}]}}));
  hooks.install();const result=JSON.parse(fs.readFileSync(file));assert.equal(result.hooks.Stop[0].matcher,'*');assert.deepEqual(result.hooks.Stop[0].hooks,[{command:'keep-me'}]);
  fs.writeFileSync(helper,'original helper');fs.writeFileSync(file,JSON.stringify({hooks:{Stop:'invalid'}}));assert.throws(()=>hooks.install());assert.equal(fs.readFileSync(helper,'utf8'),'original helper');
 } finally {if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;}
});
