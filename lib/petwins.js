'use strict';
/* Claude Session Pets — 펫별 독립 창 관리자 (메인 프로세스)
 * 이전엔 화면 전체를 덮는 투명 창 하나(pet.html)에 모든 펫을 그렸다. 그 창이 스크린샷 창 선택·다른 앱 클릭을 막아
 * 펫마다 작은 투명 창으로 바꿨다(사용자 결정 2026-09). 여기서 하는 일:
 *  · 세션 감지 루프(1초): 메인의 listSessions()로 세션 행을 받아 상태(작업 중/완료/입력 필요/유휴)를 판정(pet.js detectEvents 이식)
 *  · 세션마다 PetWindow(pet-window.html, 280×200)를 만들고 pet-event로 상태를 보낸다. 창 위치는 펫 창이 요청(pet-move)
 *  · 메인펫 창(main-pet.html), 패널 창(panel.html, 메인펫 클릭으로 토글), 헤일로 링 창(halo.html, 알림 중 펫 발 근처),
 *    스포트라이트 딤 창(dim.html, 알림 오래 미확인 시, 펫보다 한 레벨 아래), 우클릭 메뉴 창(menu.html)
 * 창은 전부 transparent·frameless·alwaysOnTop('screen-saver')·모든 스페이스 표시. 펫/헤일로/딤은 focusable:false.
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const HOOK_TTL = 1800, MIDTURN_STALE = 50, CPU_EPS = 0.02, QUIET_MS = 25000, DONE_DEBOUNCE_MS = 3000, ESCALATE_MS = 22000;
const PET_W = 280, PET_H = 200;
const MAIN_W = 360;
const PANEL_W = 460, PANEL_H = 520;
const HALO = 600;

function createPetManager({ app, BrowserWindow, screen, ipcMain, deps }) {
  const ROOT = path.join(__dirname, '..');
  const PRELOAD = path.join(ROOT, 'preload.js');
  const SETTINGS_PATH = path.join(app.getPath('userData'), 'pets-settings.json');
  let settings = { haloOn: true, spotlightOn: true, hiddenDesktop: {} };
  try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))); } catch {}
  const saveSettings = () => { try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings)); } catch {} };

  const workArea = () => screen.getPrimaryDisplay().workArea;
  const baseOpts = (w, h, extra) => Object.assign({ width: w, height: h, show: false, transparent: true, frame: false, hasShadow: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }, extra || {});
  // 디버그(SESSION_PETS_DEBUG): 렌더러 콘솔 에러를 메인 stderr로
  const watchConsole = (w, tag) => { if (process.env.SESSION_PETS_DEBUG) w.webContents.on('console-message', (e, level, msg) => { if (level >= 2) console.error('[' + tag + ']', msg); }); return w; };
  const topmost = (w) => { try { w.setAlwaysOnTop(true, 'screen-saver'); w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {} };
  const alive = (w) => w && !w.isDestroyed();
  const send = (w, ev) => { if (alive(w)) w.webContents.send('pet-event', ev); };

  // ── 창 풀: 펫·헤일로 창은 숨은 호스트 페이지(host.html)의 window.open 자식으로 연다 ──
  // 창마다 렌더러 프로세스가 생기면 창 18개에 RSS ~1.9GB. 같은 렌더러를 쓰게 하려고 process-per-site 스위치를 썼더니
  // 투명 창이 무작위로 흰 배경이 됐다(실측: 같은 옵션 창 10개 중 대부분 흰색). window.open 자식은 오프너와 렌더러를 공유하면서 투명이 유지된다.
  let hostWin = null, hostLoaded = null, openSeq = 0;
  const pendingOpen = new Map(); // frameName → { opts, cb }
  function ensureHost() {
    if (alive(hostWin)) return hostLoaded;
    hostWin = new BrowserWindow(baseOpts(1, 1));
    hostWin.webContents.setWindowOpenHandler(({ frameName }) => {
      const p = pendingOpen.get(frameName); if (!p) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: p.opts };
    });
    hostWin.webContents.on('did-create-window', (w, { frameName }) => {
      const p = pendingOpen.get(frameName); if (!p) return; pendingOpen.delete(frameName);
      try { p.cb(w); } catch (e) { console.error('[pets] open child', e); }
    });
    hostWin.on('closed', () => { hostWin = null; hostLoaded = null; });
    hostLoaded = hostWin.loadFile(path.join(ROOT, 'host.html')).catch(() => {});
    return hostLoaded;
  }
  function openChild(page, query, opts, cb) {
    const name = 'w' + (++openSeq);
    pendingOpen.set(name, { opts, cb });
    const url = pathToFileURL(path.join(ROOT, page)).href + '?' + new URLSearchParams(query).toString();
    ensureHost().then(() => {
      if (!alive(hostWin)) { pendingOpen.delete(name); return; }
      hostWin.webContents.executeJavaScript('window.open(' + JSON.stringify(url) + ',' + JSON.stringify(name) + '); void 0').catch(() => pendingOpen.delete(name));
    });
  }

  // ── 펫 창들 ──
  const pets = new Map();      // id → { win, meta, ready, halo, alert, alertSince }
  const byWc = new Map();      // webContents.id → pet id ('main' 포함)
  let mainWin = null, panelWin = null, dimWin = null, menuWin = null, menuFor = null;
  const tracked = new Map();   // id → { mode, task, taskKind, cpusec, lastAdvance, idleSince, quiet, name }
  let lastRows = [];

  function sessionState(p, t, now) {
    if (p.disconnected) return t.mode;
    if (p.provider === 'codex') return p.state || 'idle';
    if (p.hookState === 'working' && p.tstale) return 'idle';
    if (p.hookState && p.hookAge < HOOK_TTL) return p.hookState === 'working' ? 'working' : p.hookState === 'waiting' ? 'waiting' : 'idle';
    if (p.tstate === 'ended') return 'idle';
    if (p.tstate === 'midturn') return p.tage < MIDTURN_STALE ? 'working' : 'idle';
    const advanced = p.cpusec - t.cpusec > CPU_EPS; if (advanced) t.lastAdvance = now;
    return now - t.lastAdvance < QUIET_MS ? 'working' : 'idle';
  }
  function procName(p) { if (p.sessionName) return p.sessionName; if (p.cwd) return p.cwd.split('/').filter(Boolean).pop(); return 'PID ' + p.pid; }
  const isDesktop = (p) => p.provider === 'codex' && p.transport === 'desktop';
  const hiddenDesktop = (p) => isDesktop(p) && !!(settings.hiddenDesktop[p.id] && settings.hiddenDesktop[p.id].hidden);
  function wakeHiddenDesktop(p) { // pet.js wakeHiddenDesktopPet 이식: 새 턴/재개/입력 필요면 자동으로 다시 보인다
    if (p.disconnected) return false;
    const h = settings.hiddenDesktop[p.id]; const cur = { state: p.state || 'idle', turnId: p.turnId || null }; const prev = h && h.activity;
    const newTurn = prev && prev.turnId && cur.turnId && prev.turnId !== cur.turnId; const resumed = prev && prev.state !== 'working' && cur.state === 'working'; const needsInput = prev && prev.state === 'idle' && cur.state === 'waiting';
    if (newTurn || resumed || needsInput) { delete settings.hiddenDesktop[p.id]; saveSettings(); return true; }
    settings.hiddenDesktop[p.id] = { hidden: true, activity: cur }; saveSettings(); return false;
  }
  function setDesktopHidden(id, hidden) {
    const p = lastRows.find(r => r.id === id); if (!p) return;
    if (hidden) { settings.hiddenDesktop[id] = { hidden: true, activity: { state: p.state || 'idle', turnId: p.turnId || null } }; saveSettings(); removePet(id, false); }
    else { delete settings.hiddenDesktop[id]; saveSettings(); }
  }
  const metaOf = (p) => ({ id: p.id, provider: p.provider, transport: p.transport, pid: p.pid, cwd: p.cwd, tty: p.tty, name: procName(p), sessionId: p.sessionId || null });

  function createPet(p, t, st) {
    const rec = { win: null, dead: false, meta: metaOf(p), ready: false, halo: null, alert: null, alertSince: 0, initState: st, initTask: t.task, initKind: t.taskKind };
    pets.set(p.id, rec);
    openChild('pet-window.html', { id: p.id }, baseOpts(PET_W, PET_H), (win) => {
      if (rec.dead) { try { win.close(); } catch {} return; } // 창이 열리는 사이에 세션이 끝남
      rec.win = watchConsole(win, 'pet ' + p.id);
      topmost(win); win.setIgnoreMouseEvents(true, { forward: true });
      const wcId = win.webContents.id; byWc.set(wcId, p.id);
      win.on('closed', () => { if (pets.get(p.id) === rec) pets.delete(p.id); byWc.delete(wcId); }); // ⚠️ closed 이후 webContents 접근 금지(Object has been destroyed)
    });
    return rec;
  }
  function removePet(id, farewell) {
    const rec = pets.get(id); if (!rec) return;
    rec.dead = true;
    if (farewell && rec.ready && alive(rec.win)) { send(rec.win, { type: 'farewell' }); setAlert(id, null); pets.delete(id); setTimeout(() => { try { if (alive(rec.win)) rec.win.close(); } catch {} }, 2300); }
    else { setAlert(id, null); pets.delete(id); try { if (alive(rec.win)) rec.win.close(); } catch {} }
  }

  async function poll() {
    let rows;
    try { rows = await deps.listSessions(); } catch { return; }
    lastRows = rows;
    const seen = new Set(); const now = Date.now();
    for (const p of rows) {
      seen.add(p.id);
      if (hiddenDesktop(p) && !wakeHiddenDesktop(p)) { removePet(p.id, false); tracked.delete(p.id); continue; }
      const name = procName(p); const quiet = deps.isQuiet(p);
      let t = tracked.get(p.id);
      if (!t) {
        t = { name, mode: 'idle', task: null, taskKind: null, cpusec: p.cpusec, lastAdvance: 0, idleSince: 0, quiet };
        tracked.set(p.id, t);
        if (!quiet) {
          const st = sessionState(p, t, now);
          if (st === 'working') { t.mode = 'working'; t.task = p.task || p.hookTask || null; t.taskKind = p.taskKind || p.hookTaskKind || null; }
          else if (st === 'waiting') t.mode = 'waiting';
          createPet(p, t, t.mode);
        }
        continue;
      }
      t.name = name; t.quiet = t.quiet || quiet;
      const rec = pets.get(p.id);
      if (quiet && rec) removePet(p.id, false);
      if (rec && !quiet) { const m = metaOf(p); const changed = JSON.stringify(m) !== JSON.stringify(rec.meta); rec.meta = m; if (changed) send(rec.win, { type: 'meta', meta: m }); }
      const st = sessionState(p, t, now); t.cpusec = p.cpusec;
      if (st === 'working') {
        t.idleSince = 0; const task = p.task || p.hookTask || null, kind = p.taskKind || p.hookTaskKind || null;
        if (t.mode !== 'working' || t.task !== task || t.taskKind !== kind) { t.mode = 'working'; t.task = task; t.taskKind = kind; if (rec) send(rec.win, { type: 'working', task, taskKind: kind }); }
      } else if (st === 'waiting') { t.idleSince = 0; if (t.mode !== 'waiting') { t.mode = 'waiting'; if (rec) send(rec.win, { type: 'waiting' }); } }
      else if (t.mode !== 'idle') {
        if (!t.idleSince) t.idleSince = now;
        if (now - t.idleSince >= DONE_DEBOUNCE_MS) { const wasWorking = t.mode === 'working'; t.mode = 'idle'; t.idleSince = 0; if (rec) send(rec.win, { type: wasWorking && !p.runtimeError ? 'done' : 'idle' }); }
      }
    }
    for (const [id] of tracked) if (!seen.has(id)) { tracked.delete(id); removePet(id, true); }
    // 메인펫 몸짓: 우리가 띄운 실행이 있으면 work
    send(mainWin, { type: 'main-state', working: deps.runningCount() > 0, procBusy: [...tracked.values()].some(t => t.mode === 'working') });
    updateDim();
  }

  // ── 헤일로 / 딤 ──
  function setAlert(id, info) {
    const rec = pets.get(id); if (!rec) return;
    rec.alert = info;
    if (info && settings.haloOn) {
      rec.haloCenter = { cx: info.cx, cy: info.cy };
      if (rec.haloKind !== info.kind) {
        if (alive(rec.halo)) rec.halo.close(); rec.halo = null;
        const kind = info.kind; rec.haloKind = kind;
        openChild('halo.html', { kind }, baseOpts(HALO, HALO), (h) => {
          if (rec.dead || rec.haloKind !== kind || !rec.alert) { try { h.close(); } catch {} return; } // 열리는 사이에 알림이 바뀜/해제
          rec.halo = h; topmost(h); h.setIgnoreMouseEvents(true);
          h.on('closed', () => { if (rec.halo === h) { rec.halo = null; rec.haloKind = null; } });
          h.on('move', () => { if (rec.halo === h) sendHaloCenter(rec); });
          const show = () => { if (!alive(h) || h.isVisible()) return; placeHalo(rec); h.showInactive(); if (alive(rec.win)) rec.win.moveTop(); };
          h.webContents.once('did-finish-load', show); setTimeout(show, 800);
        });
      }
      placeHalo(rec);
      if (!rec.alertSince) rec.alertSince = Date.now();
      rec.alertForm = !!info.form;
    } else {
      if (alive(rec.halo)) rec.halo.close(); rec.halo = null; rec.haloKind = null;
      if (!info) { rec.alertSince = 0; rec.alertForm = false; }
    }
    updateDim();
  }
  // 헤일로 창은 작업 영역(Dock·메뉴 막대 제외) 안으로 넣어 배치하고, 링 중심은 창 안 좌표로 보낸다.
  // (펫은 화면 맨 아래라 600×600 창을 발 중심에 두면 창이 Dock 아래로 삐져나가고, macOS가 창을 Dock 위로 밀어 올려 링이 펫에서 벗어났다.
  //  밀어 올리기는 setPosition 직후가 아니라 조금 뒤에 일어나므로 'move' 이벤트에서도 중심을 다시 보낸다)
  function sendHaloCenter(rec) {
    const h = rec.halo, c = rec.haloCenter; if (!alive(h) || !c) return;
    const a = h.getBounds();
    send(h, { type: 'center', x: Math.round(c.cx - a.x), y: Math.round(c.cy - a.y) });
  }
  function placeHalo(rec) {
    const h = rec.halo, c = rec.haloCenter; if (!alive(h) || !c) return;
    const b = screen.getDisplayNearestPoint({ x: Math.round(c.cx), y: Math.round(c.cy) }).workArea;
    const wx = Math.round(Math.max(b.x, Math.min(b.x + b.width - HALO, c.cx - HALO / 2)));
    const wy = Math.round(Math.max(b.y, Math.min(b.y + b.height - HALO, c.cy - HALO / 2)));
    try { h.setPosition(wx, wy); } catch {}
    sendHaloCenter(rec);
  }
  function updateDim() {
    const now = Date.now();
    const escalate = settings.spotlightOn && [...pets.values()].some(r => r.alertSince && !r.alertForm && now - r.alertSince > ESCALATE_MS);
    if (escalate && !alive(dimWin)) {
      const wa = workArea();
      dimWin = new BrowserWindow(baseOpts(wa.width, wa.height, { x: wa.x, y: wa.y }));
      try { dimWin.setAlwaysOnTop(true, 'screen-saver', -1); dimWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
      dimWin.setIgnoreMouseEvents(true); dimWin.loadFile(path.join(ROOT, 'dim.html'));
      dimWin.once('ready-to-show', () => { if (alive(dimWin)) dimWin.showInactive(); });
    } else if (!escalate && alive(dimWin)) { dimWin.close(); dimWin = null; }
  }

  // ── 메인펫 / 패널 ──
  function createMain() {
    mainWin = watchConsole(new BrowserWindow(baseOpts(MAIN_W, 258)), 'main'); topmost(mainWin); mainWin.setIgnoreMouseEvents(true, { forward: true });
    const wcId = mainWin.webContents.id; byWc.set(wcId, 'main');
    mainWin.loadFile(path.join(ROOT, 'main-pet.html'));
    mainWin.on('closed', () => { mainWin = null; byWc.delete(wcId); });
    return mainWin;
  }
  function ensurePanel() {
    if (alive(panelWin)) return panelWin;
    panelWin = watchConsole(new BrowserWindow(baseOpts(PANEL_W, PANEL_H, { focusable: true })), 'panel');
    topmost(panelWin); const wcId = panelWin.webContents.id; byWc.set(wcId, 'panel');
    panelWin.loadFile(path.join(ROOT, 'panel.html'));
    panelWin.on('blur', () => { if (panelWin && !panelWin.suppressBlur) hidePanel(); });
    panelWin.on('closed', () => { panelWin = null; byWc.delete(wcId); });
    return panelWin;
  }
  function positionPanel() {
    if (!alive(mainWin) || !alive(panelWin)) return;
    const b = mainWin.getBounds(), wa = workArea();
    let px = Math.round(b.x + b.width / 2 - PANEL_W / 2), py = Math.round(b.y + 40 - PANEL_H);
    px = Math.max(wa.x + 8, Math.min(wa.x + wa.width - PANEL_W - 8, px));
    if (py < wa.y + 8) py = Math.min(wa.y + wa.height - PANEL_H - 8, b.y + b.height + 8);
    panelWin.setPosition(px, py);
  }
  function showPanel() { const w = ensurePanel(); positionPanel(); w.show(); w.focus(); send(w, { type: 'shown' }); send(mainWin, { type: 'panel', open: true }); }
  function hidePanel() { if (alive(panelWin) && panelWin.isVisible()) panelWin.hide(); send(mainWin, { type: 'panel', open: false }); }
  function togglePanel() { alive(panelWin) && panelWin.isVisible() ? hidePanel() : showPanel(); }
  const say = (text, ms) => send(mainWin, { type: 'say', text, ms });
  const notify = (text) => send(mainWin, { type: 'notify', text });
  const panelSend = (ch, data) => { if (alive(panelWin)) panelWin.webContents.send(ch, data); };
  const broadcast = (ev) => { send(mainWin, ev); for (const r of pets.values()) send(r.win, ev); if (alive(panelWin)) send(panelWin, ev); };

  // ── 메뉴 창 ──
  function closeMenu() { if (alive(menuWin)) { const m = menuWin; menuWin = null; menuFor = null; try { m.close(); } catch {} } }
  function openMenu(petId, items, sx, sy) {
    closeMenu();
    const m = new BrowserWindow(baseOpts(220, 300, { focusable: true, x: sx, y: sy }));
    topmost(m); menuWin = m; menuFor = petId; const wcId = m.webContents.id; byWc.set(wcId, 'menu');
    m.loadFile(path.join(ROOT, 'menu.html'), { query: { items: JSON.stringify(items) } });
    m.once('ready-to-show', () => { if (alive(m)) { m.show(); m.focus(); } });
    m.on('blur', () => { if (menuWin === m) closeMenu(); });
    m.on('closed', () => { byWc.delete(wcId); if (menuWin === m) { menuWin = null; menuFor = null; } });
  }

  // ── IPC ──
  const petOf = (e) => byWc.get(e.sender.id);
  const dbg = (...a) => { if (process.env.SESSION_PETS_DEBUG) console.error('[pets]', ...a); };
  ipcMain.on('pet-ready', (e, id) => {
    const wa = workArea(); dbg('ready', id);
    if (id === 'main') { send(mainWin, { type: 'init', wa }); if (alive(mainWin)) mainWin.showInactive(); return; }
    const rec = pets.get(id); if (!rec || !alive(rec.win)) return;
    rec.ready = true;
    send(rec.win, { type: 'init', meta: rec.meta, wa, settings: { haloOn: settings.haloOn }, state: rec.initState, task: rec.initTask, taskKind: rec.initKind });
    rec.win.showInactive();
  });
  ipcMain.on('pet-move', (e, id, x, y, haloCenter) => {
    const w = id === 'main' ? mainWin : (pets.get(id) || {}).win; if (!alive(w)) return;
    try { w.setPosition(Math.round(x), Math.round(y)); } catch {}
    if (!w.__movedOnce) { w.__movedOnce = true; dbg('first move', id, Math.round(x), Math.round(y));
      if (process.env.SESSION_PETS_DEBUG) setTimeout(() => { if (alive(w)) w.webContents.capturePage().then(img => fs.writeFileSync('/tmp/petwin-' + String(id).replace(/[^a-z0-9]/gi, '_') + '.png', img.toPNG())).catch(() => {}); }, 1500); } // 디버그: 펫 창 자가 캡처
    if (id !== 'main' && haloCenter) { const rec = pets.get(id); if (rec) { rec.haloCenter = haloCenter; placeHalo(rec); } }
  });
  ipcMain.on('main-pet-resize', (e, w, h) => { if (!alive(mainWin)) return; const b = mainWin.getBounds(); mainWin.setBounds({ x: b.x, y: b.y + b.height - h, width: w, height: h }); });
  ipcMain.on('pet-alert', (e, id, info) => setAlert(id, info));
  ipcMain.on('pet-menu', (e, id, items, sx, sy) => openMenu(id, items, Math.round(sx), Math.round(sy)));
  ipcMain.on('menu-size', (e, w, h) => { if (alive(menuWin)) { const b = menuWin.getBounds(), wa = workArea(); menuWin.setBounds({ x: Math.min(b.x, wa.x + wa.width - w - 8), y: Math.min(b.y, wa.y + wa.height - h - 8), width: w, height: h }); } });
  ipcMain.on('menu-pick', (e, action) => { const id = menuFor; closeMenu(); if (action && id) { const rec = pets.get(id); if (rec) send(rec.win, { type: 'menu-action', action }); } });
  ipcMain.on('pet-action', (e, id, action) => { if (action === 'hide-desktop') setDesktopHidden(id, true); });
  ipcMain.on('set-ignore-mouse', (e, ignore) => { const w = BrowserWindow.fromWebContents(e.sender); if (alive(w)) w.setIgnoreMouseEvents(ignore, { forward: true }); });
  ipcMain.on('toggle-panel', () => togglePanel());
  ipcMain.on('hide-panel', () => hidePanel());
  ipcMain.on('panel-event', (e, ev) => { if (ev.type === 'say') say(ev.text, ev.ms); else if (ev.type === 'notify') notify(ev.text); else if (ev.type === 'anim') send(mainWin, { type: 'anim', name: ev.name }); });
  ipcMain.on('settings-changed', (e, key, value) => {
    if (key === 'alertHalo') {
      settings.haloOn = value !== false; saveSettings();
      for (const [id, r] of pets) { if (!settings.haloOn) { if (alive(r.halo)) r.halo.close(); r.halo = null; r.haloKind = null; } else if (r.alert) setAlert(id, r.alert); }
    }
    if (key === 'alertSpotlight') { settings.spotlightOn = value !== false; saveSettings(); updateDim(); }
    broadcast({ type: 'settings', key });
  });
  ipcMain.handle('list-sessions-view', () => lastRows.map(p => ({ ...p, mode: (tracked.get(p.id) || {}).mode || (p.provider === 'codex' ? p.state : null) || 'idle', hidden: hiddenDesktop(p) })));
  ipcMain.handle('set-desktop-hidden', (e, id, hidden) => { setDesktopHidden(id, hidden); return true; });
  ipcMain.on('panel-dialog', (e, on) => { if (alive(panelWin)) panelWin.suppressBlur = !!on; });

  screen.on('display-metrics-changed', () => { const wa = workArea(); broadcast({ type: 'workarea', wa }); if (alive(dimWin)) dimWin.setBounds(wa); });

  let timer = null;
  function start() { createMain(); poll(); timer = setInterval(poll, 1000); }
  function stop() { clearInterval(timer); for (const id of [...pets.keys()]) removePet(id, false); closeMenu(); if (alive(dimWin)) dimWin.close(); if (alive(hostWin)) hostWin.close(); if (alive(panelWin)) panelWin.close(); if (alive(mainWin)) mainWin.close(); }
  function toggleVisible() { const vis = alive(mainWin) && mainWin.isVisible(); for (const w of [mainWin, ...[...pets.values()].map(r => r.win)]) { if (!alive(w)) continue; vis ? w.hide() : w.showInactive(); } }

  return { start, stop, say, notify, panelSend, get mainWin() { return mainWin; }, get panelWin() { return panelWin; }, showPanel, hidePanel, togglePanel, toggleVisible, broadcast, setAlert, pets, tracked, get settings() { return settings; } };
}

module.exports = { createPetManager };
