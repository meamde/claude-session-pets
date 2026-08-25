// 세션 폼 창(BrowserWindow)용 IPC 브리지.
// 앱이 생성한 폼 HTML만 이 preload로 로드된다(내용은 앱이 렌더 → 안전).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sessionForm', {
  // { cwd, id, answers } 를 보내 세션을 헤드리스로 이어간다
  submit: (payload) => ipcRenderer.invoke('submit-form', payload),
  cancel: () => ipcRenderer.invoke('close-form'),
  onOutput: (fn) => ipcRenderer.on('form-output', (_e, d) => fn(d)),
  onDone: (fn) => ipcRenderer.on('form-done', (_e, d) => fn(d)),
});
