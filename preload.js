const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  quit: () => ipcRenderer.send('quit-app'),
  getHome: () => ipcRenderer.invoke('get-home'),

  pickImage: () => ipcRenderer.invoke('pick-image'),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', dataUrl),
  getSavedImage: () => ipcRenderer.invoke('get-saved-image'),
  onImageChanged: (fn) => ipcRenderer.on('image-changed', (_e, url) => fn(url)),

  pickSessionImage: (key) => ipcRenderer.invoke('pick-session-image', key),
  saveSessionImage: (key, dataUrl) => ipcRenderer.invoke('save-session-image', { key, dataUrl }),
  getSessionImage: (key) => ipcRenderer.invoke('get-session-image', key),
  deleteSessionImage: (key) => ipcRenderer.invoke('delete-session-image', key),

  listForms: (sessionId) => ipcRenderer.invoke('list-forms', sessionId),
  openForm: (id) => ipcRenderer.invoke('open-form', { id }),

  listClaudeProcs: () => ipcRenderer.invoke('list-claude-procs'),
  killProc: (pid, force) => ipcRenderer.invoke('kill-proc', pid, force),
  sendToTty: (tty, text) => ipcRenderer.invoke('send-to-tty', { tty, text }),
  sendToSession: (cwd, text) => ipcRenderer.invoke('send-to-session', { cwd, text }),
  listInjectableTtys: () => ipcRenderer.invoke('list-injectable-ttys'),
  focusSession: (pid, tty) => ipcRenderer.invoke('focus-session', { pid, tty }),

  chatClaude: (opts) => ipcRenderer.invoke('chat-claude', opts),
  runClaude: (opts) => ipcRenderer.invoke('run-claude', opts),
  stopRun: (id) => ipcRenderer.invoke('stop-run', id),
  onRunOutput: (fn) => ipcRenderer.on('run-output', (_e, d) => fn(d)),
  onRunDone: (fn) => ipcRenderer.on('run-done', (_e, d) => fn(d)),

  onWorkAreaChanged: (fn) => ipcRenderer.on('work-area-changed', (_e, wa) => fn(wa)),
});
