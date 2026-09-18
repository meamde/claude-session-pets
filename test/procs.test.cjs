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
