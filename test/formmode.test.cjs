// 폼 모드 판단 규칙: 가장 가까운 켜기(<enc>)/끄기(<enc>.off) 표시 → 없으면 전체 기본값(.default-on). /session-form 명령 동작도 확인
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { harness } = require('./main-harness.cjs');
const h = harness();
const HELPER = h.context.HELPER_SRC || require('vm').runInContext('HELPER_SRC', h.context);
const CMD = require('vm').runInContext('FORM_COMMAND_SRC', h.context);
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-home-')), proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-proj-')));
  const sub = path.join(proj, 'sub'); fs.mkdirSync(sub); fs.mkdirSync(path.join(home, '.claude', 'session-pets-formmode'), { recursive: true });
  const hook = path.join(home, 'hook.py'); fs.writeFileSync(hook, HELPER);
  return { home, proj, sub, fm: path.join(home, '.claude', 'session-pets-formmode'), hook };
}
const injected = (e, cwd) => execFileSync('python3', [e.hook, 'working'], { env: { ...process.env, HOME: e.home }, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-1', cwd, prompt: 'hi' }) }).toString().includes('additionalContext');
const runCmd = (e, arg, cwd) => { const body = CMD.split('\n').filter(l => l.startsWith('    ')).map(l => l.slice(4)).join('\n').replace(/\$ARGUMENTS/g, arg); return execFileSync('bash', ['-c', body], { cwd, env: { ...process.env, HOME: e.home } }).toString(); };

test('표시 없으면 전체 기본값을 따른다', () => {
  const e = setup();
  assert.equal(injected(e, e.proj), false);
  fs.writeFileSync(path.join(e.fm, '.default-on'), 'on');
  assert.equal(injected(e, e.proj), true);
  assert.equal(injected(e, e.sub), true);
});
test('가장 가까운 표시가 이긴다 (.off는 기본값을 끈다, 하위 폴더 켜기는 상위 끄기를 이긴다)', () => {
  const e = setup(); fs.writeFileSync(path.join(e.fm, '.default-on'), 'on');
  fs.writeFileSync(path.join(e.fm, enc(e.proj) + '.off'), '');
  assert.equal(injected(e, e.proj), false);
  assert.equal(injected(e, e.sub), false);
  fs.writeFileSync(path.join(e.fm, enc(e.sub)), '');
  assert.equal(injected(e, e.sub), true);
});
test('/session-form: 기본값 켜짐에서 off는 .off 표시, on은 표시 복구, 토글', () => {
  const e = setup(); fs.writeFileSync(path.join(e.fm, '.default-on'), 'on');
  assert.match(runCmd(e, 'off', e.proj), /OFF/);
  assert.ok(fs.existsSync(path.join(e.fm, enc(e.proj) + '.off')));
  assert.equal(injected(e, e.proj), false);
  assert.match(runCmd(e, '', e.proj), /ON/);
  assert.ok(!fs.existsSync(path.join(e.fm, enc(e.proj) + '.off')));
  assert.equal(injected(e, e.proj), true);
  fs.unlinkSync(path.join(e.fm, '.default-on'));
  assert.match(runCmd(e, 'off', e.proj), /OFF/);
  assert.ok(!fs.existsSync(path.join(e.fm, enc(e.proj) + '.off')), '기본값이 꺼져 있으면 .off를 만들 필요 없음');
  assert.equal(injected(e, e.proj), false);
});
