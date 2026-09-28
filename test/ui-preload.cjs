// UI 스모크/스크린샷용 스텁 preload — 펫 창(pet-window.html)·메인펫 창(main-pet.html)·패널(panel.html)이 부르는 window.pet을 흉내 낸다.
// 메인 → 렌더러 이벤트(pet-event)는 window.smoke.fire(ev)로 주입한다.
const { contextBridge } = require('electron');
const noop = () => {};
let handler = null; const sent = [];
const row = (id, provider) => ({ id: provider + ':' + id, provider, sessionId: id, sessionName: provider + ' demo', cwd: '/tmp/shared-project', pid: provider === 'claude' ? 100 : null, cpu: 0, cpusec: 0, etime: '01:00', state: 'working', task: '같은 폴더의 독립된 세션 테스트', hookState: 'working', hookAge: 0, transport: 'desktop', mode: 'working' });
let rows = [row('11111111-1111-1111-1111-111111111111', 'claude'), row('22222222-2222-2222-2222-222222222222', 'codex'), row('33333333-3333-3333-3333-333333333333', 'codex')];
contextBridge.exposeInMainWorld('smoke', { fire: (ev) => { if (handler) handler(ev); }, sent: () => sent.slice(), setRows: (v) => { rows = v; } });
contextBridge.exposeInMainWorld('pet', {
  setIgnoreMouse: noop, petReady: (id) => sent.push(['ready', id]), petMove: (id, x, y, h) => sent.push(['move', id, x, y, h]), petAlert: (id, info) => sent.push(['alert', id, info]),
  petMenu: (id, items) => sent.push(['menu', id, items]), petAction: (id, a) => sent.push(['action', id, a]), mainPetResize: (w, h) => sent.push(['resize', w, h]),
  togglePanel: () => sent.push(['toggle-panel']), hidePanel: noop, panelEvent: (ev) => sent.push(['panel-event', ev]), panelDialog: noop, settingsChanged: (k) => sent.push(['settings', k]),
  listSessionsView: async () => rows, setDesktopHidden: async () => true, menuPick: noop, menuSize: noop, onPetEvent: (fn) => { handler = fn; },
  quit: noop, getHome: async () => '/tmp', getSavedImage: async () => null, deleteSavedImage: async () => true, getSessionImage: async () => null, onImageChanged: noop, onRunOutput: noop, onRunDone: noop,
  listSessions: async () => rows, listInjectableTtys: async () => [], listForms: async () => [],
  getUsage: async (force, provider) => provider === 'codex'
    ? { session: { pct: 34, minutes: 300, resets: '오후 6시 15분에 초기화' }, weekAll: { pct: 61, minutes: 10080, resets: '9월 17일 (수) 오전 9시에 초기화' }, windows: [{ name: 'Codex · 5시간', pct: 34, resets: '오후 6시 15분에 초기화', minutes: 300 }, { name: 'Codex · 주간', pct: 61, resets: '9월 17일 (수) 오전 9시에 초기화', minutes: 10080 }] }
    : { session: { pct: 42, resets: '오후 5시에 초기화' }, weekAll: { pct: 27, resets: '9월 18일 (목) 오전 3시에 초기화' }, weeks: [{ model: 'all models', pct: 27, resets: '9월 18일 (목) 오전 3시에 초기화' }, { model: 'Fable', pct: 18, resets: '9월 18일 (목) 오전 3시에 초기화' }], spans: [{ span: '24h', requests: 132, sessions: 6 }, { span: '7d', requests: 911, sessions: 38 }] },
  focusAgentSession: async () => ({ ok: true }), focusSession: async () => ({ ok: true }), openFolder: async () => ({ ok: true }), saveSessionImage: async () => {}, deleteSessionImage: async () => {}, codexFormMode: async () => ({ ok: true, on: true }), pickImage: async () => null, pickSessionImage: async () => null, saveImage: async () => {}, openForm: async () => ({ ok: true }),
  interruptSession: async () => ({ ok: true }), sendToSession: async () => ({ ok: true }), runClaude: async () => ({ ok: true }), runCodex: async () => ({ ok: true }), stopRun: async () => ({ ok: true }), chatClaude: async () => ({ ok: true, text: '' }), chatCodex: async () => ({ ok: true, text: '' }),
});
