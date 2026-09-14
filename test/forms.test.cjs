const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {harness}=require('./main-harness.cjs');
test('Codex forms are isolated by provider and thread; failed sends remain pending',async()=>{
 const h=harness(),cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pets-form-')),dir=path.join(cwd,'.session-pets/forms');fs.mkdirSync(dir,{recursive:true});const sid='11111111-1111-1111-1111-111111111111';
 h.codex.rows=[{sessionId:sid,cwd}];const form={provider:'codex',sessionId:sid,cwd,title:'Test',items:[{id:'choice',kind:'question',heading:'Choice',input:{type:'radio',options:['Yes','No']}}]};
 fs.writeFileSync(path.join(dir,'test.json'),JSON.stringify(form));fs.writeFileSync(path.join(dir,'other.json'),JSON.stringify({...form,sessionId:'another'}));
 const rows=await h.handlers.get('list-forms')({},sid,'codex');assert.equal(rows.length,1);const id=rows[0].id;
 assert.equal((await h.handlers.get('open-form')({},{id})).ok,true);
 h.codex.send=async()=>{throw Error('timeout')};assert.equal((await h.handlers.get('submit-form')({},{id,answers:{choice:'Yes'}})).ok,false);assert.ok(fs.existsSync(path.join(dir,'test.json')));
 let delivered;h.codex.send=async(...args)=>{delivered=args;return{ok:true,mode:'test'}};
 assert.equal((await h.handlers.get('submit-form')({},{id,answers:{choice:'Yes'}})).ok,true);assert.equal(delivered[0],sid);assert.match(delivered[1],/Yes/);assert.ok(fs.existsSync(path.join(dir,'done/test.answer.json')));assert.ok(!fs.existsSync(path.join(dir,'test.json')));assert.ok(fs.existsSync(path.join(dir,'other.json')));
 assert.equal((await h.handlers.get('open-form')({},{id:'../../etc/passwd'})).ok,false);h.codex.close();
});
