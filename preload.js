const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  // ── 펫별 독립 창 (lib/petwins.js) ──
  petReady: (id) => ipcRenderer.send('pet-ready', id),
  petMove: (id, x, y, haloCenter) => ipcRenderer.send('pet-move', id, x, y, haloCenter || null),
  petAlert: (id, info) => ipcRenderer.send('pet-alert', id, info),
  petMenu: (id, items, sx, sy) => ipcRenderer.send('pet-menu', id, items, sx, sy),
  petAction: (id, action) => ipcRenderer.send('pet-action', id, action),
  mainPetResize: (w, h) => ipcRenderer.send('main-pet-resize', w, h),
  togglePanel: () => ipcRenderer.send('toggle-panel'),
  hidePanel: () => ipcRenderer.send('hide-panel'),
  panelEvent: (ev) => ipcRenderer.send('panel-event', ev),
  panelDialog: (on) => ipcRenderer.send('panel-dialog', on),
  settingsChanged: (key, value) => ipcRenderer.send('settings-changed', key, value),
  listSessionsView: () => ipcRenderer.invoke('list-sessions-view'),
  setDesktopHidden: (id, hidden) => ipcRenderer.invoke('set-desktop-hidden', id, hidden),
  menuPick: (action) => ipcRenderer.send('menu-pick', action),
  menuSize: (w, h) => ipcRenderer.send('menu-size', w, h),
  onPetEvent: (fn) => ipcRenderer.on('pet-event', (_e, ev) => fn(ev)),
  quit: () => ipcRenderer.send('quit-app'),
  getHome: () => ipcRenderer.invoke('get-home'),

  pickImage: () => ipcRenderer.invoke('pick-image'),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', dataUrl),
  getSavedImage: () => ipcRenderer.invoke('get-saved-image'),
  deleteSavedImage: () => ipcRenderer.invoke('delete-saved-image'),
  onImageChanged: (fn) => ipcRenderer.on('image-changed', (_e, url) => fn(url)),

  pickSessionImage: (key) => ipcRenderer.invoke('pick-session-image', key),
  saveSessionImage: (key, dataUrl) => ipcRenderer.invoke('save-session-image', { key, dataUrl }),
  getSessionImage: (key) => ipcRenderer.invoke('get-session-image', key),
  deleteSessionImage: (key) => ipcRenderer.invoke('delete-session-image', key),

  getUsage: (force, provider) => ipcRenderer.invoke('get-usage', force, provider),

  listForms: (sessionId, provider) => ipcRenderer.invoke('list-forms', sessionId, provider),
  openForm: (id) => ipcRenderer.invoke('open-form', { id }),

  listSessions: () => ipcRenderer.invoke('list-sessions'),
  interruptSession: (session) => ipcRenderer.invoke('interrupt-session', session),
  focusAgentSession: (session) => ipcRenderer.invoke('focus-agent-session', session),
  codexFormMode: (id) => ipcRenderer.invoke('codex-form-mode', id),
  runCodex: (opts) => ipcRenderer.invoke('run-codex', opts),
  chatCodex: (opts) => ipcRenderer.invoke('chat-codex', opts),
  listClaudeProcs: () => ipcRenderer.invoke('list-claude-procs'),
  killProc: (pid, force) => ipcRenderer.invoke('kill-proc', pid, force),
  sendToTty: (tty, text) => ipcRenderer.invoke('send-to-tty', { tty, text }),
  sendToSession: (cwd, sessionId, text, provider) => ipcRenderer.invoke('send-to-session', { cwd, sessionId, text, provider }),
  listInjectableTtys: () => ipcRenderer.invoke('list-injectable-ttys'),
  focusSession: (pid, tty, cwd) => ipcRenderer.invoke('focus-session', { pid, tty, cwd }),
  openFolder: (cwd) => ipcRenderer.invoke('open-folder', cwd),

  chatClaude: (opts) => ipcRenderer.invoke('chat-claude', opts),
  runClaude: (opts) => ipcRenderer.invoke('run-claude', opts),
  stopRun: (id) => ipcRenderer.invoke('stop-run', id),
  onRunOutput: (fn) => ipcRenderer.on('run-output', (_e, d) => fn(d)),
  onRunDone: (fn) => ipcRenderer.on('run-done', (_e, d) => fn(d)),

  onWorkAreaChanged: (fn) => ipcRenderer.on('work-area-changed', (_e, wa) => fn(wa)),
});
