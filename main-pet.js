/* Claude Session Pets — 메인펫(어미 부엉이) 창 렌더러. pet.js의 메인펫 부분(상태머신·드래그·말풍선·HP바·이미지) 이식.
 * 창 크기는 펫 크기에 따라 메인에 요청(W=360, H=펫높이+130: 위쪽은 HP바·말풍선 자리). 클릭 → 패널 창 토글(메인). */
const $ = (s) => document.querySelector(s);
const petEl = $('#pet'), spriteEl = $('#sprite'), dotEl = $('#dot-sprite'), bubbleEl = $('#bubble'), zzzEl = $('#zzz');
let mainDot = null;
let wa = { x: 0, y: 0, width: 1440, height: 900 };
const WIN_W = 360, TOP_PAD = 130;
const S = { size: Number(localStorage.getItem('petSize')) || 128, flip: localStorage.getItem('petFlip') === '1', bgRemove: localStorage.getItem('bgRemove') !== '0',
  ax: 100, ay: 0, vy: 0, dir: 1, state: 'idle', targetX: null, stateUntil: 0, working: false, procBusy: false, panelOpen: false };
const WALK_SPEED = 1.6, GRAVITY = 1.1;
function petH() { return mainDot ? DotSprites.MOTHER_SIZE[1] * mainDot.scale : S.size; }
function winH() { return petH() + TOP_PAD; }
function ground() { return wa.y + wa.height - petH(); }
function clampX(x) { return Math.max(wa.x, Math.min(wa.x + wa.width - S.size, x)); }
let lastWin = null, lastH = 0;
function applySize() {
  petEl.style.width = S.size + 'px';
  if (mainDot) mainDot.setScale(S.size / 32);
  petEl.style.height = petH() + 'px';
  if (S.state !== 'drag' && S.state !== 'fall') S.ay = ground();
  if (winH() !== lastH) { lastH = winH(); window.pet.mainPetResize(WIN_W, lastH); lastWin = null; }
}
function setAnim(name) { petEl.className = petEl.className.replace(/anim-\w+/g, '').trim(); petEl.classList.add('interactive', 'anim-' + name); if (mainDot) mainDot.setState(name); }
function enterState(state, duration) {
  S.state = state; S.stateUntil = performance.now() + (duration || 0);
  zzzEl.classList.toggle('show', state === 'sleep');
  if (state === 'idle') setAnim(S.working ? 'work' : 'idle'); else setAnim(state);
}
function pickNextBehavior() {
  const r = Math.random();
  if (r < 0.45) { S.targetX = clampX(wa.x + Math.random() * wa.width); enterState('walk', 0); }
  else if (r < 0.85 || S.working || S.procBusy) enterState('idle', 1500 + Math.random() * 4000);
  else enterState('sleep', 6000 + Math.random() * 9000);
}
function render() {
  const flip = (S.dir === 1) !== S.flip ? 1 : -1;
  spriteEl.parentElement.style.transform = `scaleX(${flip})`;
  const wx = Math.round(S.ax - (WIN_W - S.size) / 2), wy = Math.round(S.ay - TOP_PAD);
  if (!lastWin || lastWin.x !== wx || lastWin.y !== wy) { lastWin = { x: wx, y: wy }; window.pet.petMove('main', wx, wy, null); }
}
let lastT = performance.now();
function tick(t) {
  const dt = Math.min((t - lastT) / 16.67, 3); lastT = t;
  if (S.state === 'walk') {
    const dx = S.targetX - S.ax; S.dir = dx >= 0 ? 1 : -1; S.ax += S.dir * WALK_SPEED * dt;
    if (Math.abs(dx) < WALK_SPEED * 2) { S.ax = S.targetX; enterState('idle', 1000 + Math.random() * 3000); }
  } else if (S.state === 'fall') {
    S.vy += GRAVITY * dt; S.ay += S.vy * dt;
    if (S.ay >= ground()) { S.ay = ground(); S.vy = 0; setAnim('land'); enterState('idle', 1200); }
  } else if ((S.state === 'idle' || S.state === 'sleep') && t > S.stateUntil && !S.panelOpen) pickNextBehavior();
  render();
  DotSprites.DotSprite.tickAll(t);
  requestAnimationFrame(tick);
}

// ── 드래그 & 클릭 ──
let downPos = null, grabOffset = null, moved = false;
petEl.addEventListener('mousedown', (e) => { if (e.button !== 0) return; downPos = { x: e.screenX, y: e.screenY }; grabOffset = { x: e.screenX - S.ax, y: e.screenY - S.ay }; moved = false; e.preventDefault(); });
document.addEventListener('mousemove', (e) => {
  if (!downPos) return;
  if (!moved && Math.hypot(e.screenX - downPos.x, e.screenY - downPos.y) > 6) { moved = true; petEl.classList.add('dragging'); enterState('drag', 0); window.pet.hidePanel(); }
  if (moved) { S.ax = e.screenX - grabOffset.x; S.ay = e.screenY - grabOffset.y; }
});
document.addEventListener('mouseup', () => {
  if (!downPos) return; const wasDrag = moved; downPos = null; petEl.classList.remove('dragging');
  if (wasDrag) { S.ax = clampX(S.ax); S.vy = 0; if (S.ay < ground()) enterState('fall', 0); else { S.ay = ground(); enterState('idle', 1500); } }
  else window.pet.togglePanel();
});
petEl.addEventListener('contextmenu', (e) => { // 우클릭: 명령·잡담·사용량 대상 Claude ↔ Codex 전환 (패널 select와 동일 설정)
  e.preventDefault();
  const next = localStorage.getItem('selectedProvider') === 'codex' ? 'claude' : 'codex';
  localStorage.setItem('selectedProvider', next); window.pet.settingsChanged('selectedProvider'); refreshUsage(false);
  say(next === 'codex' ? 'Codex로 전환 🟣' : 'Claude로 전환 🟠', 1500);
});
petEl.addEventListener('dragover', (e) => e.preventDefault());
petEl.addEventListener('drop', (e) => {
  e.preventDefault(); const file = e.dataTransfer.files[0]; if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader(); reader.onload = async () => { await window.pet.saveImage(reader.result); loadSprite(reader.result); say('새 모습 어때요? ✨'); }; reader.readAsDataURL(file);
});

// ── 말풍선 ──
let bubbleTimer = null;
function say(text, ms = 2500) {
  bubbleEl.textContent = text; bubbleEl.style.setProperty('--shift', '0px'); bubbleEl.classList.remove('show'); void bubbleEl.offsetWidth; bubbleEl.classList.add('show');
  const r = bubbleEl.getBoundingClientRect(); let shift = 0;
  if (r.left < 4) shift = 4 - r.left; else if (r.right > WIN_W - 4) shift = WIN_W - 4 - r.right;
  if (shift) bubbleEl.style.setProperty('--shift', shift + 'px');
  clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms);
}
const notifyQueue = []; let notifying = false;
function notify(text) { notifyQueue.push(text); if (!notifying) drainNotify(); }
function drainNotify() { if (!notifyQueue.length) { notifying = false; return; } notifying = true; say(notifyQueue.splice(0, 3).join('\n'), 2500); setTimeout(drainNotify, 2700); }

// ── HP바 (사용량) ──
function usageColor(pct) { return pct >= 90 ? '#e0453a' : pct >= 75 ? '#f5a623' : pct >= 50 ? '#e6c229' : '#57c060'; }
function setHpBar(fillId, pctId, u) { const f = $('#' + fillId), p = $('#' + pctId); if (!u || typeof u.pct !== 'number') { f.style.width = '0%'; f.style.background = '#57c060'; p.textContent = '–'; return; } f.style.width = Math.max(0, Math.min(100, u.pct)) + '%'; f.style.background = usageColor(u.pct); p.textContent = u.pct + '%'; }
let usageSeq = 0;
async function refreshUsage(force) {
  const provider = localStorage.getItem('selectedProvider') === 'codex' ? 'codex' : 'claude';
  const bars = $('#hpbars'); bars.dataset.provider = provider;
  const icon = $('#usage-provider-icon'); icon.src = provider === 'codex' ? 'assets/codex.png' : 'assets/claude.png';
  const seq = ++usageSeq; let u = null;
  try { u = await window.pet.getUsage(force, provider); } catch {}
  if (seq !== usageSeq) return;
  const labels = document.querySelectorAll('#hpbars .hplbl');
  const hoursLabel = (w, dflt) => { const m = w && w.minutes; if (!m) return dflt; if (m >= 10080) return '주간'; if (m >= 1440) return Math.round(m / 1440) + 'd'; return Math.round(m / 60) + 'h'; };
  labels[0].textContent = hoursLabel(u?.session, '5h'); labels[1].textContent = hoursLabel(u?.weekAll, '주간');
  setHpBar('hp-session', 'hp-session-pct', u && u.session);
  setHpBar('hp-week', 'hp-week-pct', u && (u.weekAll || (u.weeks && u.weeks.find(w => /all models/i.test(w.model)))));
}

// ── 이미지 (pet-window.js와 같은 배경제거·트림) ──
function processImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 512, scale = Math.min(1, MAX / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, w, h);
        const im = cx.getImageData(0, 0, w, h), d = im.data;
        if (S.bgRemove) {
          const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; });
          const oc = corners.filter(c => c[3] > 200);
          if (oc.length >= 3) { const bg = oc[0], tol = 42; const near = (i) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < tol * 3; const seen = new Uint8Array(w * h), st = [0, w - 1, (h - 1) * w, h * w - 1];
            while (st.length) { const p = st.pop(); if (seen[p]) continue; seen[p] = 1; const i = p * 4; if (!near(i)) continue; d[i + 3] = 0; const x = p % w, y = (p / w) | 0; if (x > 0) st.push(p - 1); if (x < w - 1) st.push(p + 1); if (y > 0) st.push(p - w); if (y < h - 1) st.push(p + w); } }
        }
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (maxX < 0) { resolve({ url: dataUrl }); return; }
        cx.putImageData(im, 0, 0); const tw = maxX - minX + 1, th = maxY - minY + 1; const out = document.createElement('canvas'); out.width = tw; out.height = th; out.getContext('2d').drawImage(cv, minX, minY, tw, th, 0, 0, tw, th);
        resolve({ url: out.toDataURL('image/png') });
      } catch { resolve({ url: dataUrl }); }
    };
    img.onerror = () => resolve({ url: dataUrl }); img.src = dataUrl;
  });
}
async function loadSprite(dataUrl) { spriteEl.src = (await processImage(dataUrl)).url; if (mainDot) { mainDot.destroy(); mainDot = null; } dotEl.hidden = true; spriteEl.hidden = false; applySize(); }
function useMainDot() { spriteEl.hidden = true; dotEl.hidden = false; if (!mainDot) mainDot = new DotSprites.DotSprite(dotEl, 'mother', 'claude', S.size / 32); mainDot.setState((petEl.className.match(/anim-(\w+)/) || [])[1] || 'idle'); applySize(); }
async function initSprite() { const saved = await window.pet.getSavedImage(); if (saved) await loadSprite(saved); else useMainDot(); }
window.pet.onImageChanged((url) => loadSprite(url));

// ── 메인에서 오는 이벤트 ──
window.pet.onPetEvent(async (ev) => {
  if (ev.type === 'init') {
    wa = ev.wa; S.ax = clampX(wa.x + Math.random() * (wa.width - S.size));
    await initSprite(); S.ay = ground(); applySize(); render();
    requestAnimationFrame(tick); refreshUsage(false); setInterval(() => refreshUsage(false), 300000);
    setTimeout(() => say('안녕하세요! 클릭하면 메뉴가 열려요 🐾', 4000), 800);
    return;
  }
  if (ev.type === 'workarea') { wa = ev.wa; S.ax = clampX(S.ax); if (S.state !== 'drag' && S.state !== 'fall') S.ay = ground(); render(); }
  else if (ev.type === 'say') say(ev.text, ev.ms || 2500);
  else if (ev.type === 'notify') notify(ev.text);
  else if (ev.type === 'main-state') { S.working = !!ev.working; S.procBusy = !!ev.procBusy; if (S.state === 'idle') setAnim(S.working ? 'work' : 'idle'); }
  else if (ev.type === 'anim') { if (S.state === 'idle') setAnim(ev.name); }
  else if (ev.type === 'panel') { S.panelOpen = !!ev.open; }
  else if (ev.type === 'settings') {
    S.size = Number(localStorage.getItem('petSize')) || 128; S.flip = localStorage.getItem('petFlip') === '1'; S.bgRemove = localStorage.getItem('bgRemove') !== '0';
    if (ev.key === 'bgRemove') { const saved = await window.pet.getSavedImage(); if (saved) loadSprite(saved); }
    if (ev.key === 'resetImage') { useMainDot(); say('기본 모습으로 🐾', 1500); }
    if (ev.key === 'selectedProvider') refreshUsage(false);
    if (ev.key === 'usage') refreshUsage(true);
    applySize();
  }
});
let ignoring = true;
document.addEventListener('mousemove', (e) => {
  if (downPos) return;
  const el = document.elementFromPoint(e.clientX, e.clientY); const should = !(el && el.closest('.interactive'));
  if (should !== ignoring) { ignoring = should; window.pet.setIgnoreMouse(should); }
});
window.pet.petReady('main');
