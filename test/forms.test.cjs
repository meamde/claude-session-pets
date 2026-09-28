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
test('폼 본문 서식: escape 유지 + 식별자 자동 코드·긴 문단 문장 분리·선택지 부연', () => {
 const h = harness();
 const html = h.context.renderFormHtml({ title: 't', items: [{ id: 'a', kind: 'issue', heading: 'h',
  detail: '<img src=x onerror=alert(1)> `a<b>` 는 handleServerConsume 과 consumable=false 를 씁니다. 두 번째 문장은 v1.2.3 버전 얘기입니다. 세 번째 문장도 충분히 길게 써서 문단 길이를 넘깁니다. 네 번째 문장입니다.',
  input: { type: 'radio', options: ['지금 수정 (타입 무관 Finalize)', '나중에'] } }] }, { id: 'x' });
 const body = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
 assert.ok(!/<img/.test(body), 'raw HTML must be escaped');
 assert.match(body, /<code>a&lt;b&gt;<\/code>/);
 assert.match(body, /<code>handleServerConsume<\/code>/);
 assert.match(body, /<code>consumable=false<\/code>/);
 assert.ok(!/<code>v1\.2\.3<\/code>/.test(body) && /v1\.2\.3/.test(body), 'version numbers stay plain and unsplit');
 assert.match(body, /<ul class="sents">/);
 assert.match(body, /value="지금 수정 \(타입 무관 Finalize\)"/);
 assert.match(body, /<span class="osub">타입 무관 Finalize<\/span>/);
});
test('폼 요약·흐름도·비교표 렌더 + escape', () => {
 const h = harness();
 const html = h.context.renderFormHtml({ title: 't', items: [{ id: 'a', kind: 'issue', heading: 'h', summary: '<b>x</b> 결론',
  diagram: [{ label: '현재', steps: ['A', { text: '<script>1</script>', tone: 'bad', note: 'n' }] }, { label: '후', steps: [{ text: 'C', tone: 'nope' }] }],
  table: { columns: ['c1'], rows: [['<i>r</i>']] }, input: { type: 'approve' } }, { id: 'b', heading: 'h2', diagram: ['X', 'Y'], input: { type: 'text' } }] }, { id: 'x' });
 const body = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
 assert.ok(!/<script>|<i>r<\/i>|<b>x<\/b>/.test(body), 'user text must be escaped');
 assert.match(body, /<p class="summary">&lt;b&gt;x&lt;\/b&gt; 결론<\/p>/);
 assert.match(body, /class="step t-bad"/);
 assert.ok(!/t-nope/.test(body), 'unknown tone ignored');
 assert.equal((body.match(/<div class="flow">/g) || []).length, 3, 'two rows + one plain-array diagram');
 assert.match(body, /<table class="tbl">/);
});
