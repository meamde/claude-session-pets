/* Claude Session Pets — 세션펫 창 렌더러 (펫 하나 = 창 하나)
 * 이전엔 화면 전체를 덮는 창 하나에 모든 펫을 그렸는데(pet.js), 그 창이 스크린샷 창 선택·다른 앱 클릭을 막아
 * 펫마다 독립된 작은 투명 창으로 바꿨다(사용자 요청). 이 파일은 옛 SessionPet 클래스의 이식판:
 *  · 위치는 스크린 좌표(작업 영역 wa 기준)로 계산하고, 창 이동은 메인에 요청(petMove) — 창이 펫을 따라다닌다
 *  · 상태(작업 중/완료/입력 필요/유휴/종료)는 메인(lib/petwins.js)이 훅·트랜스크립트로 판정해 pet-event로 보낸다
 *  · 헤일로 링·우클릭 메뉴는 별도 창(메인이 관리), 이 창은 요청만 한다
 * 창 크기 280×200: .spet(72×110 = 스프라이트 90 + 이름표 20)를 하단 중앙에 두고 위 90px은 말풍선 자리.
 */
const $ = (s) => document.querySelector(s);
const W = 280, H = 200, PAD_X = 104, PAD_TOP = 90; // 창 안에서 .spet의 위치
const SPET_SIZE = 72, SPET_H = 90, SLABEL_H = 20, SPET_HH = SPET_H + SLABEL_H;
const SPET_SPEED = 1.2, GRAVITY = 1.1;
const ID = new URLSearchParams(location.search).get('id');
let wa = { x: 0, y: 0, width: 1440, height: 900 };
let settings = { haloOn: true, bgRemove: true };

function clampX(ax) { return Math.max(wa.x, Math.min(wa.x + wa.width - SPET_SIZE, ax)); }
function groundY() { return wa.y + wa.height - SPET_HH; }

// ── 이미지 배경 제거 + 트림 (pet.js processImage 이식) ──
function processImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 512;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, w, h);
        const im = cx.getImageData(0, 0, w, h), d = im.data;
        if (settings.bgRemove) {
          // 네 모서리 색이 배경: 비슷한 색을 flood fill로 투명하게
          const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; });
          const opaqueCorners = corners.filter(c => c[3] > 200);
          if (opaqueCorners.length >= 3) {
            const bg = opaqueCorners[0]; const tol = 42;
            const near = (i) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < tol * 3;
            const seen = new Uint8Array(w * h); const stack = [];
            for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) stack.push(y * w + x);
            while (stack.length) { const p = stack.pop(); if (seen[p]) continue; seen[p] = 1; const i = p * 4; if (!near(i)) continue; d[i + 3] = 0; const x = p % w, y = (p / w) | 0; if (x > 0) stack.push(p - 1); if (x < w - 1) stack.push(p + 1); if (y > 0) stack.push(p - w); if (y < h - 1) stack.push(p + w); }
          }
        }
        // 트림
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (maxX < 0) { resolve({ url: dataUrl, cx: 0.5, cy: 1 }); return; }
        cx.putImageData(im, 0, 0);
        const tw = maxX - minX + 1, th = maxY - minY + 1;
        const out = document.createElement('canvas'); out.width = tw; out.height = th;
        out.getContext('2d').drawImage(cv, minX, minY, tw, th, 0, 0, tw, th);
        resolve({ url: out.toDataURL('image/png'), cx: 0.5, cy: 1 });
      } catch { resolve({ url: dataUrl, cx: 0.5, cy: 1 }); }
    };
    img.onerror = () => resolve({ url: dataUrl, cx: 0.5, cy: 1 });
    img.src = dataUrl;
  });
}

class SessionPet {
  constructor(meta) {
    Object.assign(this, { id: meta.id, provider: meta.provider, transport: meta.transport, pid: meta.pid, cwd: meta.cwd, tty: meta.tty, name: meta.name, sessionId: meta.sessionId || null });
    this.key = (this.provider === 'codex' ? 'codex:' : '') + (this.cwd || ('pid:' + this.pid));
    this.flip = localStorage.getItem('spetFlip:' + this.key) === '1';
    this.ax = clampX(wa.x + Math.random() * wa.width); this.ay = groundY(); this.vy = 0;
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.state = 'idle'; this.stateUntil = performance.now() + 1000 + Math.random() * 2000; this.targetX = null;
    this.sticky = null; this.working = false; this.workTask = null; this.workTaskKind = null;
    this.cx = 0.5; this.cy = 1; this.pendingForm = null; this.alertKind = null;
    this.lastWin = null; this.dot = null;

    const el = document.createElement('div');
    el.className = 'spet interactive anim-idle';
    el.innerHTML = '<div class="sbubble"></div><div class="swrap"><span class="sbody"><span class="sbounce"><img class="ssprite" hidden><canvas class="ssprite dot"></canvas></span></span></div><div class="session-caption"><div class="slabel"></div></div>';
    el.dataset.provider = this.provider; el.dataset.desktop = String(this.isDesktop());
    const badge = document.createElement('span'); badge.className = 'desktop-badge'; badge.innerHTML = '<span class="monitor-screen"></span>';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'desktop-close'; close.textContent = '×'; close.title = '펫 숨기기 (작업은 계속됩니다)';
    close.addEventListener('mousedown', e => e.stopPropagation()); close.addEventListener('click', e => { e.stopPropagation(); window.pet.petAction(ID, 'hide-desktop'); });
    el.append(badge, close);
    this.el = el; this.spriteEl = el.querySelector('img.ssprite'); this.dotEl = el.querySelector('canvas.ssprite');
    this.bodyEl = el.querySelector('.sbody'); this.bubbleEl = el.querySelector('.sbubble'); this.labelEl = el.querySelector('.slabel');
    const icon = document.createElement('img'); icon.className = 'provider-icon'; icon.src = this.provider === 'codex' ? 'assets/codex.png' : 'assets/claude.png';
    this.nameEl = document.createElement('span'); this.nameEl.className = 'session-name'; this.nameEl.textContent = this.name;
    this.labelEl.append(this.nameEl); el.querySelector('.session-caption').prepend(icon);
    document.body.appendChild(el);
    this.bindPointer(); this.loadImage(); this.render();
  }
  isDesktop() { return this.provider === 'codex' && this.transport === 'desktop'; }
  async loadImage() {
    try { const saved = await window.pet.getSessionImage(this.key); if (saved) await this.setSprite(saved); else this.useDot(); } catch { this.useDot(); }
  }
  useDot() {
    this.spriteEl.hidden = true; this.dotEl.hidden = false;
    if (!this.dot) this.dot = new DotSprites.DotSprite(this.dotEl, 'chick', this.provider === 'codex' ? 'codex' : 'claude', 3);
    this.dot.setState(this.state); this.cx = 0.5; this.cy = 1; this.render();
  }
  async setSprite(dataUrl) {
    const r = await processImage(dataUrl);
    if (this.dot) { this.dot.destroy(); this.dot = null; }
    this.dotEl.hidden = true; this.spriteEl.hidden = false;
    this.cx = r.cx ?? 0.5; this.cy = r.cy ?? 1; this.spriteEl.src = r.url; this.render();
  }
  flash(text, ms = 2200) { this.showBubble(text); setTimeout(() => this.restoreBubble(), ms); }
  async assignImage() { let url; try { url = await window.pet.pickSessionImage(this.key); } catch { return; } if (url) { this.setSprite(url); this.flash('새 모습이에요! ✨', 2000); } }
  async focusWindow() {
    let r;
    try { r = this.provider === 'codex' && this.transport !== 'cli' ? await window.pet.focusAgentSession({ provider: this.provider, sessionId: this.sessionId }) : await window.pet.focusSession(this.pid, this.tty, this.cwd); }
    catch { this.flash('앞으로 못 가져왔어요 😿'); return; }
    if (r.ok) this.flash('여기예요! 👀');
    else if (r.error === 'automation') this.flash('자동화 권한이 필요해요 ⚙️');
    else if (r.error === 'accessibility') this.flash('손쉬운 사용 권한을 켜주세요 ⚙️ 설정을 열었어요 — 목록에 없으면 + 로 앱 추가');
    else if (r.error === 'nohost') this.flash('창을 찾지 못했어요 🤔');
    else this.flash('앞으로 못 가져왔어요 😿');
  }
  async openFolder() {
    if (!this.cwd) { this.flash('작업 폴더를 몰라요 🤔', 1800); return; }
    let r; try { r = await window.pet.openFolder(this.cwd); } catch { r = { ok: false }; }
    this.flash(r && r.ok ? '📁 폴더 열었어요' : '폴더를 못 열었어요 😿', 1600);
  }
  menuItems() {
    const items = [{ id: 'focus', mark: '👀', label: '창 앞으로 가져오기' }, { id: 'folder', mark: '📁', label: 'Finder에서 작업 폴더 열기' }];
    if (this.provider === 'codex') items.push({ id: 'form-mode', mark: '📋', label: '폼 모드 켜기/끄기' });
    if (this.isDesktop()) items.push({ id: 'hide-desktop', mark: '×', label: '펫 숨기기 (작업 유지)' });
    items.push({ sep: true }, { id: 'image', mark: '🖼️', label: '이미지 변경…' }, { id: 'flip', mark: this.flip ? '✓' : '↔️', label: '좌우 반전' }, { id: 'reset', mark: '🐾', label: '기본 모습으로' });
    return items;
  }
  async menuAction(action) {
    if (action === 'focus') this.focusWindow();
    else if (action === 'folder') this.openFolder();
    else if (action === 'form-mode') { const r = await window.pet.codexFormMode(this.sessionId); this.flash(!r.ok ? ('오류: ' + r.error) : r.on ? '📋 폼 모드 ON (다음 메시지부터)' : '폼 모드 OFF', 2500); }
    else if (action === 'hide-desktop') window.pet.petAction(ID, 'hide-desktop');
    else if (action === 'image') this.assignImage();
    else if (action === 'flip') this.toggleFlip();
    else if (action === 'reset') this.resetImage();
  }
  toggleFlip() { this.flip = !this.flip; localStorage.setItem('spetFlip:' + this.key, this.flip ? '1' : '0'); this.render(); this.flash(this.flip ? '↔️ 좌우 반전!' : '↔️ 원래대로', 1500); }
  async resetImage() { try { await window.pet.deleteSessionImage(this.key); } catch {} this.useDot(); this.flash('기본 모습으로 🐾', 1500); }

  bindPointer() {
    const el = this.el;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this._down = { x: e.screenX, y: e.screenY }; this._grab = { x: e.screenX - this.ax, y: e.screenY - this.ay }; this._moved = false; this._dragging = true;
      clearTimeout(this._holdTimer);
      if (this.isDesktop()) this._holdTimer = setTimeout(() => { if (!this._dragging || this._moved) return; this._dragging = false; document.body.classList.add('pet-editing'); }, 600);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      if (!this._moved && Math.hypot(e.screenX - this._down.x, e.screenY - this._down.y) > 6) { clearTimeout(this._holdTimer); this._moved = true; el.classList.add('grabbing'); this.enter('drag', 0); }
      if (this._moved) { this.ax = e.screenX - this._grab.x; this.ay = e.screenY - this._grab.y; this.render(); }
    });
    document.addEventListener('mouseup', () => {
      if (!this._dragging) return;
      clearTimeout(this._holdTimer); this._dragging = false; el.classList.remove('grabbing');
      if (this._moved) { this.ax = clampX(this.ax); this.vy = 0; if (this.ay < groundY()) this.enter('fall', 0); else { this.ay = groundY(); this.landRestore(); } this.render(); }
      else this.onClick();
    });
    el.addEventListener('dblclick', () => this.focusWindow());
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); window.pet.petMenu(ID, this.menuItems(), e.screenX, e.screenY); });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault(); const file = e.dataTransfer.files[0]; if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader(); reader.onload = async () => { await window.pet.saveSessionImage(this.key, reader.result); this.setSprite(reader.result); }; reader.readAsDataURL(file);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('pet-editing'); });
  }

  setAnim(a) { for (const n of [...this.el.classList]) if (n.startsWith('anim-')) this.el.classList.remove(n); this.el.classList.add('anim-' + a); }
  enter(state, dur) {
    this.state = state; this.stateUntil = performance.now() + (dur || 0);
    this.setAnim(['walk', 'work', 'done', 'wait', 'drag', 'fall'].includes(state) ? state : 'idle');
    if (this.dot) this.dot.setState(state);
  }
  landRestore() { const back = this.sticky === 'form' ? 'wait' : this.sticky === 'done' ? 'done' : this.sticky === 'wait' ? 'wait' : this.working ? 'work' : 'idle'; this.enter(back, back === 'idle' ? 1500 : 0); }
  setName(n) { if (n && n !== this.name) { this.name = n; this.nameEl.textContent = n; } }
  showBubble(text, big = false) { this.bubbleEl.textContent = text; this.bubbleEl.classList.toggle('big', big); this.bubbleEl.classList.remove('show'); void this.bubbleEl.offsetWidth; this.bubbleEl.classList.add('show'); }
  hideBubble() { this.bubbleEl.classList.remove('show'); }
  restoreBubble() {
    if (this.state === 'bye') return;
    if (this.sticky === 'form') this.showBubble('📋 입력이 필요해요! (클릭)', true);
    else if (this.sticky === 'done') this.showBubble('🎉 작업 완료!', true);
    else if (this.sticky === 'wait') this.showBubble('🙋 입력 필요!', true);
    else if (this.working) this.showBubble(this.workBubbleText());
    else this.hideBubble();
  }
  async checkForms() {
    if (this.state === 'bye' || !this.sessionId) return;
    let forms = []; try { forms = await window.pet.listForms(this.sessionId, this.provider); } catch { return; }
    const f = forms && forms[0];
    if (f) {
      if (!this.pendingForm || this.pendingForm.id !== f.id || this.sticky !== 'form') {
        this.pendingForm = f; this.sticky = 'form'; this.working = false;
        if (!this.inAir()) this.enter('wait', 0);
        this.showBubble('📋 입력이 필요해요! (클릭)', true); this.setAlert('wait');
      }
    } else if (this.pendingForm) { this.pendingForm = null; if (this.sticky === 'form') this.goIdle(); }
  }
  workBubbleText() { return (this.workTaskKind === 'prompt' ? '>_' : '🏃') + ' ' + (this.workTask || '작업 중…'); }
  inAir() { return this.state === 'drag' || this.state === 'fall'; }
  setAlert(kind) {
    this.el.classList.add('alerting'); this.el.classList.toggle('alert-done', kind === 'done'); this.el.classList.toggle('alert-wait', kind !== 'done');
    this.alertKind = kind; window.pet.petAlert(ID, { kind, form: !!this.pendingForm, cx: Math.round(this.ax + SPET_SIZE / 2), cy: Math.round(this.ay + 60) });
  }
  clearAlert() { this.el.classList.remove('alerting', 'alert-done', 'alert-wait'); if (this.alertKind) { this.alertKind = null; window.pet.petAlert(ID, null); } }
  setWorking(task, kind) { if (this.state === 'bye') return; this.sticky = null; this.working = true; this.workTask = task || null; this.workTaskKind = kind || null; this.clearAlert(); if (!this.inAir()) this.enter('work', 0); this.showBubble(this.workBubbleText()); }
  setDone() { if (this.state === 'bye' || this.pendingForm) return; this.sticky = 'done'; this.working = false; if (!this.inAir()) this.enter('done', 0); this.showBubble('🎉 작업 완료!', true); this.setAlert('done'); }
  setWaiting() { if (this.state === 'bye' || this.pendingForm) return; this.sticky = 'wait'; this.working = false; if (!this.inAir()) this.enter('wait', 0); this.showBubble('🙋 입력 필요!', true); this.setAlert('wait'); }
  goIdle() { if (this.state === 'bye') return; this.sticky = null; this.working = false; this.clearAlert(); this.hideBubble(); if (!this.inAir()) this.enter('idle', 800); }
  onClick() {
    if (this.state === 'bye') return;
    if (this.pendingForm) { window.pet.openForm(this.pendingForm.id); return; }
    if (this.working) return;
    if (this.sticky) this.goIdle();
  }
  farewell() { this._dragging = false; this.sticky = null; this.working = false; this.clearAlert(); this.enter('bye', 0); this.showBubble('👋 안녕~'); this.render(); }

  update(dt, now) {
    if (this.isDesktop() && document.body.classList.contains('pet-editing') && !['drag', 'fall', 'bye'].includes(this.state)) { this.render(); return; }
    if (this.state === 'drag') { this.render(); return; }
    if (this.state === 'bye') { this.ay = groundY(); this.render(); return; }
    if (this.state === 'fall') {
      this.vy += GRAVITY * dt; this.ay += this.vy * dt;
      if (this.ay >= groundY()) { this.ay = groundY(); this.vy = 0; this.landRestore(); }
      this.render(); return;
    }
    if (this.state === 'walk') {
      const dx = this.targetX - this.ax; this.dir = dx >= 0 ? 1 : -1; this.ax += this.dir * SPET_SPEED * dt;
      if (Math.abs(dx) < SPET_SPEED * 2) { this.ax = this.targetX; this.enter('idle', 1500 + Math.random() * 3000); }
    } else if (this.state === 'idle' && now > this.stateUntil) {
      if (Math.random() < 0.5) { this.targetX = clampX(wa.x + Math.random() * wa.width); this.enter('walk', 0); }
      else this.enter('idle', 1500 + Math.random() * 3500);
    }
    this.ay = groundY(); this.render();
  }
  render() {
    const facing = (this.dir === 1) !== this.flip ? 1 : -1;
    this.spriteEl.style.transform = `scaleX(${facing})`; this.dotEl.style.transform = `scaleX(${facing})`;
    const ox = facing === -1 ? (1 - this.cx) : this.cx;
    this.bodyEl.style.transformOrigin = (ox * 100).toFixed(2) + '% ' + (this.cy * 100).toFixed(2) + '%';
    // 창 이동 (변했을 때만)
    const wx = Math.round(this.ax - PAD_X), wy = Math.round(this.ay - PAD_TOP);
    if (!this.lastWin || this.lastWin.x !== wx || this.lastWin.y !== wy) {
      this.lastWin = { x: wx, y: wy };
      window.pet.petMove(ID, wx, wy, this.alertKind ? { cx: Math.round(this.ax + SPET_SIZE / 2), cy: Math.round(this.ay + 60) } : null);
    }
  }
}

let spet = null; // ⚠️ 'pet'은 preload(window.pet)와 이름이 겹쳐 SyntaxError — 다른 이름 사용
window.pet.onPetEvent((ev) => {
  if (ev.type === 'init') {
    wa = ev.wa; settings = Object.assign(settings, ev.settings || {});
    spet = new SessionPet(ev.meta);
    if (ev.state === 'working') spet.setWorking(ev.task, ev.taskKind); else if (ev.state === 'waiting') spet.setWaiting();
    return;
  }
  if (!spet) return;
  if (ev.type === 'workarea') { wa = ev.wa; spet.ax = clampX(spet.ax); if (!spet.inAir()) spet.ay = groundY(); spet.render(); }
  else if (ev.type === 'meta') { Object.assign(spet, ev.meta); spet.setName(ev.meta.name); spet.el.dataset.desktop = String(spet.isDesktop()); }
  else if (ev.type === 'working') spet.setWorking(ev.task, ev.taskKind);
  else if (ev.type === 'done') spet.setDone();
  else if (ev.type === 'waiting') spet.setWaiting();
  else if (ev.type === 'idle') spet.goIdle();
  else if (ev.type === 'farewell') spet.farewell();
  else if (ev.type === 'menu-action') spet.menuAction(ev.action);
  else if (ev.type === 'settings') { settings = Object.assign(settings, ev.settings || {}); }
});

// 마우스 통과: 펫(.interactive) 위에서만 마우스를 받는다 — 투명한 나머지 영역은 아래 앱으로 통과
let ignoring = true;
document.addEventListener('mousemove', (e) => {
  if (pet && spet._dragging) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const should = !(el && el.closest('.interactive'));
  if (should !== ignoring) { ignoring = should; window.pet.setIgnoreMouse(should); }
});

let lastT = performance.now();
function tick(t) {
  const dt = Math.min((t - lastT) / 16.67, 3); lastT = t;
  if (spet) spet.update(dt, t);
  DotSprites.DotSprite.tickAll(t);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
setInterval(() => { if (pet) spet.checkForms(); }, 2000);
window.pet.petReady(ID);
