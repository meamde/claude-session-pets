// README 스크린샷용 스텁 preload — 더미 세션 데이터만 제공한다 (실제 프로세스/IPC 없음)
const { contextBridge } = require('electron');
const noop = () => {};
let rows = [];
contextBridge.exposeInMainWorld('shot', { setRows: (v) => { rows = v; } });
contextBridge.exposeInMainWorld('pet', {
  setIgnoreMouse: noop, quit: noop, getHome: async () => '/Users/dev', getSavedImage: async () => null, deleteSavedImage: async () => true,
  getSessionImage: async () => null, onImageChanged: noop, onWorkAreaChanged: noop, onRunOutput: noop, onRunDone: noop,
  listSessions: async () => rows, listInjectableTtys: async () => [], listForms: async () => [],
  getUsage: async (_force, provider) => provider === 'codex'
    ? { session: { pct: 34, minutes: 300, resets: '오후 6시 15분에 초기화' }, weekAll: { pct: 61, minutes: 10080, resets: '9월 17일 (수) 오전 9시에 초기화' },
        windows: [{ name: 'Codex · 5시간', pct: 34, resets: '오후 6시 15분에 초기화' }, { name: 'Codex · 주간', pct: 61, resets: '9월 17일 (수) 오전 9시에 초기화' }] }
    : { session: { pct: 42, resets: '오후 5시에 초기화' }, weekAll: { pct: 27, resets: '9월 18일 (목) 오전 3시에 초기화' },
        weeks: [{ model: 'all models', pct: 27, resets: '9월 18일 (목) 오전 3시에 초기화' }, { model: 'Fable', pct: 18, resets: '9월 18일 (목) 오전 3시에 초기화' }],
        spans: [{ span: '24h', requests: 132, sessions: 6 }, { span: '7d', requests: 911, sessions: 38 }] },
  focusAgentSession: async () => ({ ok: true }), focusSession: async () => ({ ok: true }), openFolder: async () => ({ ok: true }),
  saveSessionImage: async () => {}, deleteSessionImage: async () => {}, codexFormMode: async () => ({ ok: true, on: true }),
  pickImage: async () => null, pickSessionImage: async () => null, saveImage: async () => {}, openForm: async () => ({ ok: true }),
  interruptSession: async () => ({ ok: true }), sendToSession: async () => ({ ok: true }), runClaude: async () => ({ ok: true }),
  runCodex: async () => ({ ok: true }), stopRun: async () => ({ ok: true }), chatClaude: async () => ({ ok: true, text: '' }),
  chatCodex: async () => ({ ok: true, text: '' }),
});
