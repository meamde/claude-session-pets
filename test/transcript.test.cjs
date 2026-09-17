// 트랜스크립트 판정: 활동 시각은 파일 mtime이 아니라 마지막 '메시지' 항목의 timestamp,
// 응답 없이 오래된 user 프롬프트(실행 안 된 대기열 입력)는 살아있는 작업으로 보지 않는다.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pets-home-'));
process.env.HOME = home; // main.js는 os.homedir()를 호출 시점에 읽는다
const { harness } = require('./main-harness.cjs');
const { context } = harness();
const parseTranscriptTail = vm.runInContext('parseTranscriptTail', context);
const listSessionsForCwd = vm.runInContext('listSessionsForCwd', context);
const projectDir = vm.runInContext('projectDir', context);

const line = (o) => JSON.stringify(o) + '\n';
const iso = (agoSec) => new Date(Date.now() - agoSec * 1000).toISOString();
const asst = (agoSec, stop) => line({ type: 'assistant', timestamp: iso(agoSec), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: '끝' }] } });
const userText = (agoSec, text) => line({ type: 'user', timestamp: iso(agoSec), message: { role: 'user', content: text } });
const bookkeeping = () => line({ type: 'artifact-autoreact-ledger', v: 1 }) + line({ type: 'file-history-snapshot' }) + line({ type: 'system', timestamp: iso(1) });

test('턴 종료 뒤 부기 항목이 붙어도 활동 시각은 마지막 메시지 기준', () => {
  const f = path.join(home, 'a.jsonl');
  fs.writeFileSync(f, userText(700, '해줘') + asst(650, 'end_turn') + bookkeeping());
  const r = parseTranscriptTail(f);
  assert.equal(r.state, 'ended'); assert.equal(r.reason, 'assistant-end');
  assert.ok(Math.abs((Date.now() - r.tsMs) / 1000 - 650) < 5, '부기 항목(방금)이 아니라 assistant 메시지(650초 전) 시각');
});

test('최근 user 프롬프트는 midturn(응답 대기), 오래된 것은 ended(실행 안 된 대기열 입력)', () => {
  const cwd = path.join(home, 'work', 'proj'); fs.mkdirSync(projectDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(projectDir(cwd), 's1.jsonl'), asst(900, 'end_turn') + userText(20, '방금 입력') + bookkeeping());
  let [s] = listSessionsForCwd(cwd);
  assert.equal(s.state, 'midturn'); assert.equal(s.stalePrompt, false); assert.ok(s.ageSec < 60);
  fs.writeFileSync(path.join(projectDir(cwd), 's1.jsonl'), asst(2000, 'end_turn') + userText(1500, '오래된 입력') + bookkeeping());
  [s] = listSessionsForCwd(cwd);
  assert.equal(s.state, 'ended'); assert.equal(s.stalePrompt, true); assert.ok(s.ageSec > 1000, 'mtime(방금)이 아니라 프롬프트 시각(1500초 전)');
});

test('도구 실행 중(assistant tool_use)은 midturn', () => {
  const f = path.join(home, 'b.jsonl');
  fs.writeFileSync(f, asst(5, 'tool_use') + line({ type: 'user', timestamp: iso(3), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }));
  assert.deepEqual([parseTranscriptTail(f).state, parseTranscriptTail(f).reason], ['midturn', 'assistant-tool_use']);
});
