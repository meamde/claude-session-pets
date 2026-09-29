// 프로세스 필터: Claude Code 내부 도우미(daemon / bg-pty-host / bg-spare)는 세션이 아니다 → 펫 금지
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('vm');
const { harness } = require('./main-harness.cjs');
const { context } = harness();
const isInternalClaudeHelper = vm.runInContext('isInternalClaudeHelper', context);

test('데몬·spare pty 도우미는 내부 프로세스로 판별', () => {
  const internal = [
    '/Users/me/.local/bin/claude daemon run --origin transient --spawned-by {"label":"claude","cwd":"/Users/me"}',
    'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-503/1b300a16/spare/7ffd8955.pty.sock 200 50 -- /Users/me/.local/bin/claude',
    'claude bg-spare --bg-spare /tmp/cc-daemon-503/1b300a16/spare/aa851634.claim.sock',
    '/Users/me/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-503/x/spare/y.pty.sock',
  ];
  for (const c of internal) assert.equal(isInternalClaudeHelper(c), true, c);
});

test('실제 세션 명령은 통과 (프롬프트에 daemon 같은 단어가 있어도)', () => {
  const real = ['claude', 'claude --continue', 'claude -p -- "daemon 코드 리뷰해줘"', '/Users/me/.local/bin/claude --resume abc', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'];
  for (const c of real) assert.equal(isInternalClaudeHelper(c), false, c);
});

test('cwd가 cc-daemon 아래면 내부', () => {
  assert.equal(isInternalClaudeHelper('claude', '/private/tmp/cc-daemon-503/1b300a16/spare'), true);
  assert.equal(isInternalClaudeHelper('claude', '/Users/me/work/proj'), false);
});

test('세션 등록 파일 병합: 파킹 껍데기 제거, versions 바이너리 세션 추가, sid 고정', () => {
  const mergeRegistry = vm.runInContext('mergeRegistry', context);
  const allProcs = new Map([
    [23368, { ppid: 1, cpu: 0, cpusec: 0, etime: '1:00', tty: 'ttys005', command: 'claude' }],
    [91256, { ppid: 91016, cpu: 0, cpusec: 0, etime: '0:10', tty: 'ttys011', command: '/Users/me/.local/share/claude/versions/2.1.276 --session-id c059 --fork-session --resume x.jsonl' }],
    [64099, { ppid: 2, cpu: 0, cpusec: 0, etime: '5:00', tty: 'ttys001', command: 'claude --continue' }],
  ]);
  const registry = new Map([
    [23368, { pid: 23368, sessionId: '7a64', cwd: '/Users/me/proj', name: 'proj-88', kind: 'interactive', parkedJobId: 'c059', jobId: null }],
    [91256, { pid: 91256, sessionId: 'c059', cwd: '/Users/me/proj', name: '파킹된 잡', kind: 'bg', parkedJobId: null, jobId: 'c059' }],
    [64099, { pid: 64099, sessionId: 'aaaa', cwd: '/Users/me/other', name: 'other-c9', kind: 'interactive', parkedJobId: null, jobId: null }],
    [99999, { pid: 99999, sessionId: 'dead', cwd: '/x', name: 'dead', kind: 'interactive' }], // 죽은 pid
  ]);
  const procs = [{ pid: 23368, command: 'claude', cwd: null }, { pid: 64099, command: 'claude --continue', cwd: null }]; // ps 필터가 잡은 것(91256은 못 잡음)
  const out = mergeRegistry(procs, allProcs, registry);
  const pids = out.map(p => p.pid).sort();
  assert.deepEqual(pids, [64099, 91256], '껍데기 23368 제거, 91256 추가, 죽은 99999 무시');
  const bg = out.find(p => p.pid === 91256);
  assert.equal(bg.reg.sessionId, 'c059'); assert.equal(bg.cwd, '/Users/me/proj'); assert.equal(bg.tty, 'ttys011');
});

test('파킹 잡이 죽었으면 원래 터미널 세션은 그대로 보인다', () => {
  const mergeRegistry = vm.runInContext('mergeRegistry', context);
  const allProcs = new Map([[23368, { ppid: 1, cpu: 0, cpusec: 0, etime: '1:00', tty: 'ttys005', command: 'claude' }]]);
  const registry = new Map([[23368, { pid: 23368, sessionId: '7a64', cwd: '/Users/me/proj', name: 'proj-88', kind: 'interactive', parkedJobId: 'c059' }], [91256, { pid: 91256, sessionId: 'c059', jobId: 'c059', kind: 'bg' }]]);
  const out = mergeRegistry([{ pid: 23368, command: 'claude', cwd: null }], allProcs, registry);
  assert.deepEqual(out.map(p => p.pid), [23368]); assert.equal(out[0].reg.sessionId, '7a64');
});

test('세션이 아닌 하위 명령(claude agents 등)은 제외, 프롬프트 속 단어는 통과', () => {
  const { isInternalClaudeHelper } = context;
  for (const c of ['claude agents', '/Users/me/.local/bin/claude agents', 'claude mcp list', 'claude doctor', 'claude update']) assert.equal(isInternalClaudeHelper(c, '/Users/me/proj'), true, c);
  for (const c of ['claude -p "agents 정리해줘"', 'claude --resume abc', 'claude']) assert.equal(isInternalClaudeHelper(c, '/Users/me/proj'), false, c);
});
test('등록 파일에 올라온 bg-spare 예비 프로세스는 세션에서 빠진다', () => {
  const { mergeRegistry } = context;
  const all = new Map([[32155, { ppid: 1, cpu: 0, cpusec: 0, etime: '0:10', tty: null, command: 'claude bg-spare --bg-spare /tmp/cc-daemon-503/x/spare/y.claim.sock' }], [4101, { ppid: 1, cpu: 0, cpusec: 0, etime: '1:00', tty: 'ttys001', command: 'claude' }]]);
  const reg = new Map([[32155, { pid: 32155, sessionId: 'spare1', cwd: '/Users/me', name: 'spare1', kind: 'bg', jobId: 'spare1' }], [4101, { pid: 4101, sessionId: 'real', cwd: '/Users/me/proj', name: 'proj-1', kind: 'interactive' }]]);
  const out = mergeRegistry([{ pid: 4101, cwd: '/Users/me/proj' }], all, reg);
  assert.deepEqual(out.map(p => p.pid), [4101]);
});
