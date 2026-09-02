/* Claude Session Pets — 렌더러 로직
 * 상태머신(배회/잠자기/드래그/낙하) + 이미지 배경제거 + 패널 UI
 */

const $ = (s) => document.querySelector(s);
const petEl = $('#pet');
const spriteEl = $('#sprite');
const badgeEl = $('#badge');
const bubbleEl = $('#bubble');
const zzzEl = $('#zzz');
const panelEl = $('#panel');

// ── 상태 ─────────────────────────────────────────────────────
const S = {
  size: Number(localStorage.getItem('petSize')) || 128,
  flip: localStorage.getItem('petFlip') === '1',
  bgRemove: localStorage.getItem('bgRemove') !== '0',
  x: 100, y: 0,
  vx: 0, vy: 0,
  dir: 1,                 // 1 = 오른쪽
  state: 'idle',          // idle | walk | sleep | drag | fall
  targetX: null,
  stateUntil: 0,
  working: false,         // 우리가 띄운 claude 세션이 실행 중
  procBusy: false,        // 시스템의 claude 프로세스가 바쁨
};
const WALK_SPEED = 1.6;
const GRAVITY = 1.1;

function ground() { return window.innerHeight - S.size; }
function clampX(x) { return Math.max(0, Math.min(window.innerWidth - S.size, x)); }

function applySize() {
  petEl.style.width = S.size + 'px';
  petEl.style.height = S.size + 'px';
  if (S.state !== 'drag' && S.state !== 'fall') S.y = ground();
}
applySize();
S.x = clampX(Math.random() * (window.innerWidth - S.size));
S.y = ground();

function setAnim(name) {
  petEl.className = petEl.className.replace(/anim-\w+/g, '').trim();
  petEl.classList.add('interactive', 'anim-' + name);
}

function enterState(state, duration) {
  S.state = state;
  S.stateUntil = performance.now() + (duration || 0);
  zzzEl.classList.toggle('show', state === 'sleep');
  if (state === 'idle') setAnim(S.working ? 'work' : 'idle');
  else if (state === 'walk') setAnim('walk');
  else if (state === 'sleep') setAnim('sleep');
  else if (state === 'drag') setAnim('drag');
  else if (state === 'fall') setAnim('fall');
}

function pickNextBehavior() {
  const r = Math.random();
  if (r < 0.45) {
    // 걷기: 랜덤 목적지
    S.targetX = clampX(Math.random() * (window.innerWidth - S.size));
    enterState('walk', 0);
  } else if (r < 0.85 || S.working || S.procBusy) {
    enterState('idle', 1500 + Math.random() * 4000);
  } else {
    enterState('sleep', 6000 + Math.random() * 9000);
  }
}

// ── 메인 루프 ────────────────────────────────────────────────
let lastT = performance.now();
function tick(t) {
  const dt = Math.min((t - lastT) / 16.67, 3); // 프레임 보정
  lastT = t;

  if (S.state === 'walk') {
    const dx = S.targetX - S.x;
    S.dir = dx >= 0 ? 1 : -1;
    S.x += S.dir * WALK_SPEED * dt;
    if (Math.abs(dx) < WALK_SPEED * 2) {
      S.x = S.targetX;
      enterState('idle', 1000 + Math.random() * 3000);
    }
  } else if (S.state === 'fall') {
    S.vy += GRAVITY * dt;
    S.y += S.vy * dt;
    if (S.y >= ground()) {
      S.y = ground();
      S.vy = 0;
      setAnim('land');
      enterState('idle', 1200);
    }
  } else if ((S.state === 'idle' || S.state === 'sleep') && t > S.stateUntil && !panelOpen) {
    pickNextBehavior();
  }

  const flip = (S.dir === 1) !== S.flip ? 1 : -1;
  petEl.style.transform = `translate(${S.x}px, ${S.y}px)`;
  spriteEl.parentElement.style.transform = `scaleX(${flip})`;

  for (const sp of [...sessionPets.values()]) sp.update(dt, t);

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  S.x = clampX(S.x);
  if (S.state !== 'drag' && S.state !== 'fall') S.y = ground();
  for (const sp of sessionPets.values()) sp.x = clampXW(sp.x, SPET_SIZE);
});

// ── 마우스 통과 제어 ─────────────────────────────────────────
// 창 전체가 화면을 덮으므로, 인터랙티브 요소 위에서만 마우스를 받는다.
let ignoring = true;
let dragging = false;
let dragPet = null; // 현재 드래그 중인 세션 펫
document.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const should = !(el && el.closest('.interactive'));
  if (should !== ignoring) {
    ignoring = should;
    window.pet.setIgnoreMouse(should);
  }
});

// 세션 펫 드래그
document.addEventListener('mousemove', (e) => {
  if (!dragPet) return;
  const sp = dragPet;
  if (!sp._moved && Math.hypot(e.clientX - sp._down.x, e.clientY - sp._down.y) > 6) {
    sp._moved = true;
    sp.el.classList.add('grabbing');
    sp.enter('drag', 0);
  }
  if (sp._moved) {
    sp.x = e.clientX - sp._grab.x;
    sp.y = e.clientY - sp._grab.y;
    sp.render();
  }
});
document.addEventListener('mouseup', () => {
  if (!dragPet) return;
  const sp = dragPet;
  dragPet = null;
  dragging = false;
  sp.el.classList.remove('grabbing');
  if (sp._moved) {
    sp.x = clampXW(sp.x, SPET_SIZE);
    sp.vy = 0;
    if (sp.y < sp.groundY()) {
      sp.enter('fall', 0);
    } else {
      sp.y = sp.groundY();
      sp.landRestore();
    }
    sp.render();
  } else {
    sp.onClick(); // 이동 없이 클릭 → 완료/입력필요 말풍선 확인
  }
});

// ── 드래그 & 클릭 ────────────────────────────────────────────
let downPos = null, grabOffset = null, moved = false;

petEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  downPos = { x: e.clientX, y: e.clientY };
  grabOffset = { x: e.clientX - S.x, y: e.clientY - S.y };
  moved = false;
  dragging = true;
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!downPos) return;
  if (!moved && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) {
    moved = true;
    petEl.classList.add('dragging');
    enterState('drag', 0);
    hidePanel();
  }
  if (moved) {
    S.x = e.clientX - grabOffset.x;
    S.y = e.clientY - grabOffset.y;
  }
});

document.addEventListener('mouseup', (e) => {
  if (!downPos) return;
  const wasDrag = moved;
  downPos = null;
  dragging = false;
  petEl.classList.remove('dragging');
  if (wasDrag) {
    S.x = clampX(S.x); // 화면 밖으로 끌어다 놓아도 보이는 영역 안에 착지시킨다
    S.vy = 0;
    if (S.y < ground()) enterState('fall', 0);
    else { S.y = ground(); enterState('idle', 1500); }
  } else {
    togglePanel();
  }
});

// ── 말풍선 ───────────────────────────────────────────────────
let bubbleTimer = null;
function say(text, ms = 2500) {
  bubbleEl.textContent = text;
  bubbleEl.style.setProperty('--shift', '0px');
  bubbleEl.classList.remove('show');
  void bubbleEl.offsetWidth; // pop 애니메이션 재시작
  bubbleEl.classList.add('show');
  // 화면 밖으로 잘리면 안쪽으로 밀고, 꼬리는 펫 위에 남긴다
  const r = bubbleEl.getBoundingClientRect();
  let shift = 0;
  if (r.left < 8) shift = 8 - r.left;
  else if (r.right > window.innerWidth - 8) shift = window.innerWidth - 8 - r.right;
  if (shift) bubbleEl.style.setProperty('--shift', shift + 'px');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms);
}

// 알림 큐: 이벤트가 몰려도 순서대로 하나씩 보여준다
const notifyQueue = [];
let notifying = false;
function notify(text) {
  notifyQueue.push(text);
  if (!notifying) drainNotify();
}
function drainNotify() {
  if (!notifyQueue.length) { notifying = false; return; }
  notifying = true;
  // 밀리지 않게 쌓인 알림은 한 말풍선에 최대 3줄로 묶어서 보여준다
  const batch = notifyQueue.splice(0, 3);
  say(batch.join('\n'), 2500);
  setTimeout(drainNotify, 2700);
}

// ── 패널 ─────────────────────────────────────────────────────
let panelOpen = false;

function positionPanel() {
  const pw = panelEl.offsetWidth, ph = panelEl.offsetHeight;
  let px = S.x + S.size / 2 - pw / 2;
  let py = S.y - ph - 14;
  px = Math.max(8, Math.min(window.innerWidth - pw - 8, px));
  if (py < 8) py = Math.min(window.innerHeight - ph - 8, S.y + S.size + 14);
  panelEl.style.left = px + 'px';
  panelEl.style.top = py + 'px';
}

function togglePanel() { panelOpen ? hidePanel() : showPanel(); }

function showPanel() {
  panelOpen = true;
  panelEl.classList.add('show');
  enterState('idle', 0);
  positionPanel();
  refreshProcs();
  const active = document.querySelector('.tab-body.active');
  (active?.querySelector('input[type=text], textarea') || $('#chat-input')).focus();
}

function hidePanel() {
  panelOpen = false;
  panelEl.classList.remove('show');
}

$('#panel-close').addEventListener('click', hidePanel);

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-body').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab.dataset.tab));
    if (tab.dataset.tab === 'procs') refreshProcs();
    if (tab.dataset.tab === 'usage') refreshUsage(true); // 탭 열면 강제 최신화
  });
});

// ── 사용량 (/usage): 메인펫 HP바 + 사용량 탭 ──────────
// 사용량 %에 따른 색: 낮음=여유(초록) → 높음=경고(빨강)
function usageColor(pct) {
  if (pct == null) return '#888';
  if (pct >= 90) return '#e0654e';
  if (pct >= 75) return '#e8a13c';
  if (pct >= 50) return '#e8d13c';
  return '#57c060';
}
function setHpBar(fillId, pctId, u) {
  const fill = $(fillId), lbl = $(pctId);
  const pct = u ? u.pct : null;
  fill.style.width = (pct == null ? 0 : Math.min(100, pct)) + '%';
  fill.style.background = usageColor(pct);
  lbl.textContent = pct == null ? '–' : pct + '%';
}
async function refreshUsage(force) {
  let u = null;
  try { u = await window.pet.getUsage(force); } catch {}
  // HP바 갱신 (세션=5h, 주간=all models)
  const week = u && (u.weekAll || (u.weeks && u.weeks.find(w => /all models/i.test(w.model))));
  setHpBar('#hp-session', '#hp-session-pct', u && u.session);
  setHpBar('#hp-week', '#hp-week-pct', week);
  // 탭이 열려 있으면 상세도 렌더
  const body = $('#usage-body');
  if (body && document.querySelector('.tab-body[data-tab="usage"]').classList.contains('active')) {
    renderUsageTab(body, u);
  }
}
function gaugeHtml(name, u) {
  if (!u) return '';
  const c = usageColor(u.pct);
  const wrap = document.createElement('div');
  wrap.className = 'ugauge';
  const top = document.createElement('div'); top.className = 'ugauge-top';
  const nm = document.createElement('span'); nm.className = 'ugauge-name'; nm.textContent = name;
  const pc = document.createElement('span'); pc.className = 'ugauge-pct'; pc.style.color = c; pc.textContent = u.pct + '%';
  top.append(nm, pc);
  const track = document.createElement('div'); track.className = 'ugauge-track';
  const fill = document.createElement('div'); fill.className = 'ugauge-fill';
  fill.style.width = Math.min(100, u.pct) + '%'; fill.style.background = c;
  track.appendChild(fill);
  const rs = document.createElement('div'); rs.className = 'ugauge-reset'; rs.textContent = 'resets ' + u.resets;
  wrap.append(top, track, rs);
  return wrap;
}
function renderUsageTab(body, u) {
  body.textContent = '';
  if (!u) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '사용량을 불러오지 못했어요'; body.appendChild(e); return; }
  // 세션(5h)
  const s = gaugeHtml('현재 세션 (5시간)', u.session); if (s) body.appendChild(s);
  // 주간: all models 먼저, 그 외 모델(Fable 등) 이어서
  for (const w of (u.weeks || [])) {
    const label = /all models/i.test(w.model) ? '이번 주 (전체)' : '이번 주 (' + w.model + ')';
    const g = gaugeHtml(label, w); if (g) body.appendChild(g);
  }
  // 상세(24h/7d) — raw에서 인사이트 줄을 그대로 보여준다(간단·안정)
  for (const sp of (u.spans || [])) {
    const blk = document.createElement('div'); blk.className = 'ublock';
    const h = document.createElement('h4'); h.textContent = sp.span === '24h' ? '최근 24시간' : '최근 7일';
    const big = document.createElement('div'); big.className = 'big';
    big.textContent = `${sp.requests} 요청 · ${sp.sessions} 세션`;
    blk.append(h, big);
    body.appendChild(blk);
  }
}

// ── 세션 펫 (실행 중인 다른 claude 세션마다 하나씩) ──────────
const SPET_SIZE = 66;
const SLABEL_H = 20;
const SPET_SPEED = 1.2;

// 기본 세션펫 캐릭터: 오른쪽을 보는 작은 생물 (클로드 오렌지 + 노란 부리).
// 회전축은 render()/processImage가 "발"(바닥 밴드 가로중심, 세로는 바닥)로 자동 계산 — 어떤 캐릭터/커스텀 이미지든 발 딛고 갸웃.
let SPET_ICON = null;
function defaultSpetIcon() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
    '<path d="M34 96 Q30 60 52 44 Q78 24 96 42 Q112 58 96 82 Q84 100 60 100 Z" fill="#d97757"/>' +
    '<path d="M44 96 L44 112 L54 112 L54 98 Z" fill="#b85c3e"/>' +
    '<path d="M70 96 L70 112 L80 112 L80 96 Z" fill="#b85c3e"/>' +
    '<circle cx="88" cy="52" r="8" fill="#fff"/><circle cx="91" cy="52" r="4" fill="#26211c"/>' +
    '<path d="M96 58 L114 54 L98 66 Z" fill="#f2b705"/>' +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

const sessionPets = new Map(); // pid -> SessionPet

// 세션펫 우클릭 메뉴는 화면에 하나만 (바깥을 누르면 닫힌다)
let spetMenuEl = null;
function closeSpetMenu() { if (spetMenuEl) { spetMenuEl.remove(); spetMenuEl = null; } }
document.addEventListener('mousedown', (e) => {
  if (spetMenuEl && !e.target.closest('.spet-menu')) closeSpetMenu();
}, true);

function clampXW(x, w) { return Math.max(0, Math.min(window.innerWidth - w, x)); }

class SessionPet {
  constructor(pid, name, cwd, tty) {
    this.pid = pid;
    this.name = name;
    this.tty = tty || null;
    this.key = cwd || ('pid:' + pid); // 이미지 저장 키 (프로젝트 경로 기준으로 재시작해도 유지)
    this.flip = localStorage.getItem('spetFlip:' + this.key) === '1'; // 좌우 반전(이미지 설정, key별 저장)
    this.x = clampXW(Math.random() * window.innerWidth, SPET_SIZE);
    this.y = this.groundY();
    this.vy = 0;
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.state = 'idle';           // idle | walk | work | done | wait | drag | fall | bye
    this.prevState = 'idle';       // 드래그 후 복귀용
    this.stateUntil = performance.now() + 1000 + Math.random() * 2000;
    this.targetX = null;
    this.sticky = null;            // 'done' | 'wait' | null (클릭 전까지 유지되는 말풍선)
    this.working = false;          // 작업 중이면 클릭/드래그해도 말풍선 유지
    this.workTask = null;          // 현재 작업 내용 한 줄 요약 (훅이 제공, 없으면 null)
    this.workTaskKind = null;      // 'prompt'(사용자 프롬프트) | 'tool'(진행 중 작업) | null
    this.cx = 0.5; this.cy = 1;  // 회전축(이미지 0~1). 바닥중앙 고정 = 바닥점 기준 갸우뚱. render()가 사용
    this.pendingForm = null;       // docs/form에 대기 중인 입력 폼 {id,title} (있으면 클릭 시 폼 열림)
    this.sessionId = null;         // 이 펫의 세션 id (폼을 세션 단위로 매칭 — 남의 폼 가로채기 방지)

    const el = document.createElement('div');
    el.className = 'spet interactive anim-idle';
    el.innerHTML =
      '<div class="sbubble"></div>' +
      '<div class="swrap"><span class="sbody"><span class="sbounce"><img class="ssprite"></span></span></div>' +
      '<div class="slabel"></div>';
    el.querySelector('.ssprite').src = SPET_ICON;
    this.el = el;
    this.spriteEl = el.querySelector('.ssprite');
    this.bodyEl = el.querySelector('.sbody');
    this.bubbleEl = el.querySelector('.sbubble');
    this.labelEl = el.querySelector('.slabel');
    this.labelEl.textContent = name;
    document.body.appendChild(el);
    this.render();
    this.bindPointer();
    this.loadImage();
  }

  async loadImage() {
    try {
      const saved = await window.pet.getSessionImage(this.key);
      // 저장된 커스텀이 있으면 그것, 없으면 기본 캐릭터 — 둘 다 배경제거+트림을 거친다
      const r = await processImage(saved || SPET_ICON);
      this.cx = r.cx ?? 0.5; this.cy = r.cy ?? 0.5; this.spriteEl.src = r.url; this.render();
    } catch {}
  }
  async setSprite(dataUrl) {
    const r = await processImage(dataUrl);
    this.cx = r.cx ?? 0.5; this.cy = r.cy ?? 0.5; this.spriteEl.src = r.url; this.render();
  }
  async assignImage() {
    let url;
    try { url = await window.pet.pickSessionImage(this.key); } catch { return; }
    if (url) { this.setSprite(url); this.showBubble('새 모습이에요! ✨'); setTimeout(() => this.restoreBubble(), 2000); }
  }
  async focusWindow() {
    const flash = (text) => {
      this.showBubble(text);
      setTimeout(() => this.restoreBubble(), 2200);
    };
    let r;
    try { r = await window.pet.focusSession(this.pid, this.tty); }
    catch { flash('앞으로 못 가져왔어요 😿'); return; }
    if (r.ok) flash('여기예요! 👀');
    else if (r.error === 'automation')
      flash('자동화 권한이 필요해요 ⚙️');
    else if (r.error === 'nohost')
      flash('창을 찾지 못했어요 🤔');
    else flash('앞으로 못 가져왔어요 😿');
  }

  // 우클릭 이미지 설정 메뉴
  showMenu(e) {
    closeSpetMenu();
    const m = document.createElement('div');
    m.className = 'spet-menu interactive';
    const item = (mark, label, fn) => {
      const it = document.createElement('div');
      it.className = 'spet-menu-item';
      const mk = document.createElement('span');
      mk.className = 'mk';
      mk.textContent = mark;
      const tx = document.createElement('span');
      tx.textContent = label;
      it.append(mk, tx);
      it.addEventListener('click', (ev) => { ev.stopPropagation(); closeSpetMenu(); fn(); });
      m.appendChild(it);
    };
    const sep = () => { const s = document.createElement('div'); s.className = 'spet-menu-sep'; m.appendChild(s); };
    item('👀', '창 앞으로 가져오기', () => this.focusWindow());
    sep();
    item('🖼️', '이미지 변경…', () => this.assignImage());
    item(this.flip ? '✓' : '↔️', '좌우 반전', () => this.toggleFlip());
    item('🐾', '기본 모습으로', () => this.resetImage());
    document.body.appendChild(m);
    // 화면 안에 들어오도록 위치 보정
    const mw = m.offsetWidth, mh = m.offsetHeight;
    const x = Math.min(e.clientX, window.innerWidth - mw - 8);
    const y = Math.min(e.clientY, window.innerHeight - mh - 8);
    m.style.left = Math.max(8, x) + 'px';
    m.style.top = Math.max(8, y) + 'px';
    spetMenuEl = m;
  }

  toggleFlip() {
    this.flip = !this.flip;
    localStorage.setItem('spetFlip:' + this.key, this.flip ? '1' : '0');
    this.render();
    this.showBubble(this.flip ? '↔️ 좌우 반전!' : '↔️ 원래대로');
    setTimeout(() => this.restoreBubble(), 1500);
  }

  async resetImage() {
    try { await window.pet.deleteSessionImage(this.key); } catch {}
    await this.setSprite(SPET_ICON); // 기본 캐릭터도 트림+피봇 계산을 거친다
    this.showBubble('기본 모습으로 🐾');
    setTimeout(() => this.restoreBubble(), 1500);
  }

  bindPointer() {
    const el = this.el;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragPet = this;
      dragging = true;
      this._down = { x: e.clientX, y: e.clientY };
      this._grab = { x: e.clientX - this.x, y: e.clientY - this.y };
      this._moved = false;
    });
    el.addEventListener('dblclick', () => this.assignImage());
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showMenu(e); });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = async () => {
        await window.pet.saveSessionImage(this.key, reader.result);
        this.setSprite(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  groundY() { return window.innerHeight - SPET_SIZE - SLABEL_H; }

  setAnim(a) {
    this.el.className = 'spet interactive anim-' + a + (this.el.classList.contains('grabbing') ? ' grabbing' : '');
  }

  enter(state, dur) {
    this.state = state;
    this.stateUntil = performance.now() + (dur || 0);
    const a = state === 'walk' ? 'walk'
      : state === 'work' ? 'work'
      : state === 'done' ? 'done'
      : state === 'wait' ? 'wait'
      : state === 'drag' ? 'drag'
      : state === 'fall' ? 'fall'
      : 'idle';
    this.setAnim(a);
  }

  // 낙하/드래그가 끝난 뒤 현재 모드에 맞는 상태로 복귀
  landRestore() {
    const back = this.sticky === 'done' ? 'done'
      : this.sticky === 'wait' ? 'wait'
      : this.working ? 'work'
      : 'idle';
    this.enter(back, back === 'idle' ? 1500 : 0);
  }

  setName(n) {
    if (n && n !== this.name) { this.name = n; this.labelEl.textContent = n; }
  }

  showBubble(text, big = false) {
    this.bubbleEl.textContent = text;
    this.bubbleEl.classList.toggle('big', big);
    this.bubbleEl.classList.remove('show');
    void this.bubbleEl.offsetWidth; // 팝 애니메이션 재시작
    this.bubbleEl.classList.add('show');
  }
  hideBubble() { this.bubbleEl.classList.remove('show'); }

  // 현재 모드에 맞는 상시 말풍선을 다시 보여준다 (임시 말풍선이 끝난 뒤 등)
  restoreBubble() {
    if (this.state === 'bye') return;
    if (this.sticky === 'form') this.showBubble('📋 입력이 필요해요! (클릭)', true);
    else if (this.sticky === 'done') this.showBubble('🎉 작업 완료!', true);
    else if (this.sticky === 'wait') this.showBubble('🙋 입력 필요!', true);
    else if (this.working) this.showBubble(this.workBubbleText());
    else this.hideBubble();
  }

  // docs/form에 새 폼이 있으면 '입력 필요' 말풍선을 띄우고, 없어지면 치운다
  async checkForms() {
    if (this.state === 'bye') return;
    if (!this.sessionId) return; // 내 세션 id를 알아야 공용 폴더에서 내 폼을 찾는다
    let forms = [];
    try { forms = await window.pet.listForms(this.sessionId); } catch { return; }
    const f = forms && forms[0];
    if (f) {
      if (!this.pendingForm || this.pendingForm.id !== f.id) {
        this.pendingForm = f;
        this.sticky = 'form';
        this.working = false;
        if (!this.inAir()) this.enter('wait', 0);
        this.showBubble('📋 입력이 필요해요! (클릭)', true);
      }
    } else if (this.pendingForm) {
      this.pendingForm = null;
      if (this.sticky === 'form') this.goIdle();
    }
  }

  // 프롬프트(사용자가 넘긴 것)는 '>_', 진행 중 작업은 '🏃'로 구분 표시
  workBubbleText() {
    const icon = this.workTaskKind === 'prompt' ? '>_' : '🏃';
    return icon + ' ' + (this.workTask || '작업 중…');
  }

  // 드래그/낙하 중엔 상태를 바꾸지 않는다 (착지 시 landRestore가 반영)
  inAir() { return this.state === 'drag' || this.state === 'fall'; }

  setWorking(task, kind) {
    if (this.state === 'bye') return;
    this.sticky = null;
    this.working = true;
    this.workTask = task || null;
    this.workTaskKind = kind || null;
    if (!this.inAir()) this.enter('work', 0);
    this.showBubble(this.workBubbleText());
  }
  setDone() {
    if (this.state === 'bye') return;
    this.sticky = 'done';
    this.working = false;
    if (!this.inAir()) this.enter('done', 0);
    this.showBubble('🎉 작업 완료!', true);
  }
  setWaiting() {
    if (this.state === 'bye') return;
    this.sticky = 'wait';
    this.working = false;
    if (!this.inAir()) this.enter('wait', 0);
    this.showBubble('🙋 입력 필요!', true);
  }
  goIdle() {              // 완료/대기 없이 조용히 유휴로 (세션 시작 등)
    if (this.state === 'bye') return;
    this.sticky = null;
    this.working = false;
    this.hideBubble();
    if (!this.inAir()) this.enter('idle', 800);
  }
  onClick() {
    if (this.state === 'bye') return;
    if (this.pendingForm) {    // 대기 중인 폼이 있으면 폼 창을 연다
      window.pet.openForm(this.pendingForm.id);
      return;
    }
    if (this.working) return;  // 작업 중 말풍선은 클릭해도 유지
    if (this.sticky) {         // 완료/입력필요 말풍선 확인 → 치우고 평소대로
      this.goIdle();
    }
  }
  farewell() {
    // 드래그 중 세션이 끝나면 전역 드래그 상태를 풀어준다 (파괴될 펫을 계속 붙잡지 않게)
    if (dragPet === this) { dragPet = null; dragging = false; }
    closeSpetMenu();
    this.sticky = null;
    this.working = false;
    this.enter('bye', 0);
    this.showBubble('👋 안녕~');
    this.render();
    setTimeout(() => this.destroy(), 2200);
  }
  destroy() {
    this.el.remove();
    // 조회 실패로 잠깐 사라졌다가 같은 pid로 새 펫이 만들어진 경우,
    // 옛 펫의 지연된 destroy가 "새" 펫을 맵에서 지우지 않도록 자기 자신일 때만 삭제.
    if (sessionPets.get(this.pid) === this) sessionPets.delete(this.pid);
  }

  update(dt, now) {
    if (this.state === 'drag') { this.render(); return; } // 드래그 중엔 손이 위치 제어
    if (this.state === 'bye') { this.y = this.groundY(); this.render(); return; }
    if (this.state === 'fall') {
      this.vy += GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y >= this.groundY()) {
        this.y = this.groundY();
        this.vy = 0;
        this.landRestore();
      }
      this.render();
      return;
    }
    if (this.state === 'walk') {
      const dx = this.targetX - this.x;
      this.dir = dx >= 0 ? 1 : -1;
      this.x += this.dir * SPET_SPEED * dt;
      if (Math.abs(dx) < SPET_SPEED * 2) {
        this.x = this.targetX;
        this.enter('idle', 1500 + Math.random() * 3000);
      }
    } else if (this.state === 'idle') {
      if (now > this.stateUntil) {
        if (Math.random() < 0.5) {
          this.targetX = clampXW(Math.random() * window.innerWidth, SPET_SIZE);
          this.enter('walk', 0);
        } else {
          this.enter('idle', 1500 + Math.random() * 3500);
        }
      }
    }
    // work / done 상태에서는 제자리에서 대기 (말풍선을 안정적으로 보여주기 위해)
    this.y = this.groundY();
    this.render();
  }

  render() {
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
    // 좌우 반전은 이미지(.ssprite)에만 건다. 몸짓 애니메이션은 .sbody에 있어서
    // 반전해도 회전 각도가 뒤집히지 않는다. dir(진행 방향) XOR flip(사용자 설정).
    const facing = (this.dir === 1) !== this.flip ? 1 : -1;
    this.spriteEl.style.transform = `scaleX(${facing})`;
    // 회전축 = 바닥중앙(cx=0.5, cy=1). 바닥점 고정, 위에서 좌우로 갸우뚱(역진자).
    // cx=0.5라 미러(facing===-1)해도 1-cx=0.5로 불변 → 방향 바꿔도 축이 안 튄다.
    const ox = facing === -1 ? (1 - this.cx) : this.cx;
    this.bodyEl.style.transformOrigin = (ox * 100).toFixed(2) + '% ' + (this.cy * 100).toFixed(2) + '%';
  }
}

// ── Claude 프로세스 모니터링 ─────────────────────────────────
let procs = [];
// pid -> { name, mode, cpusec, lastAdvance, calm, quiet } 이전 폴링 상태
let tracked = null;
const myRunPids = new Set(); // 우리가 띄운 claude -p (세션 말풍선과 중복 알림 방지)

// 상태 판정 신호 (우선순위):
//   1) 훅 상태(hookState): 가장 정확. Claude Code 생명주기 훅이 직접 기록.
//      'working' | 'waiting'(입력 필요) | 'idle'.
//   2) 훅이 없으면 트랜스크립트(tstate): 'ended'→유휴, 'midturn'→진행 중(단 오래되면 유휴).
//   3) 둘 다 없으면 누적 CPU 시간(cpusec) 증가로 폴백.
const HOOK_TTL = 1800;     // 훅 상태가 이 초보다 오래되면 신뢰 안 함 (크래시 대비)
const MIDTURN_STALE = 50;  // midturn인데 트랜스크립트가 이 초 이상 조용하면 유휴
const CPU_EPS = 0.02;      // (폴백) 이 이상 cpusec가 늘면 작업으로 간주 (초)
const QUIET_MS = 25000;    // (폴백) 이만큼 CPU 시간이 멈춰있어야 완료
const DONE_DEBOUNCE_MS = 3000; // 유휴가 이 시간 이상 지속되면 완료 확정 (벽시계 기준, 깜빡임 방지)

function procName(p) {
  if (p.sessionName) return p.sessionName;   // 크로스세션 세션 이름(myproj-e4 등) — 같은 폴더 다중 세션 구분
  if (p.cwd) return p.cwd.split('/').filter(Boolean).pop();
  return 'PID ' + p.pid;
}

// 이번 폴링의 세션 상태: 'working' | 'waiting' | 'idle'
function sessionState(p, t, now) {
  if (p.hookState && p.hookAge < HOOK_TTL) {   // 훅이 최우선 (가장 정확)
    if (p.hookState === 'working') return 'working';
    if (p.hookState === 'waiting') return 'waiting';
    return 'idle';
  }
  if (p.tstate === 'ended') return 'idle';
  if (p.tstate === 'midturn') return p.tage < MIDTURN_STALE ? 'working' : 'idle';
  const advanced = p.cpusec - t.cpusec > CPU_EPS; // unknown → CPU 폴백
  if (advanced) t.lastAdvance = now;
  return now - t.lastAdvance < QUIET_MS ? 'working' : 'idle';
}

function detectEvents() {
  const first = tracked === null;
  if (first) tracked = new Map();
  const seen = new Set();
  const now = performance.now();

  for (const p of procs) {
    seen.add(p.pid);
    const name = procName(p);
    const quiet = myRunPids.has(p.pid) || p.chat; // 메인펫의 직접 실행/잡담은 세션펫 제외
    let t = tracked.get(p.pid);
    if (!t) {
      // lastAdvance를 과거(0)로 두면, 훅/트랜스크립트가 없는 세션의 첫 폴링은
      // CPU 폴백에서 idle로 판정된다 (첫 회는 cpusec baseline만 잡음). 이게 없으면
      // 앱을 켜는 순간 놀고 있던 세션도 '작업 중'으로 떴다가 곧 가짜 '작업 완료!'가 뜬다.
      t = { name, mode: 'idle', task: null, taskKind: null, cpusec: p.cpusec, lastAdvance: 0, idleSince: 0, quiet };
      tracked.set(p.pid, t);
      if (!quiet) {
        const sp = new SessionPet(p.pid, name, p.cwd, p.tty);
        sp.sessionId = p.sessionId || null;
        sessionPets.set(p.pid, sp);
        const st = sessionState(p, t, now);
        if (st === 'working') { t.mode = 'working'; t.task = p.hookTask || null; t.taskKind = p.hookTaskKind || null; sp.setWorking(t.task, t.taskKind); }
        else if (st === 'waiting') { t.mode = 'waiting'; sp.setWaiting(); }
      }
      continue;
    }
    t.name = name; // cwd가 늦게 조회되는 경우 갱신
    t.quiet = t.quiet || quiet;
    const sp = sessionPets.get(p.pid);
    if (sp) { sp.setName(name); if (p.sessionId) sp.sessionId = p.sessionId; }

    const st = sessionState(p, t, now);
    t.cpusec = p.cpusec;
    if (st === 'working') {
      t.idleSince = 0;
      const task = p.hookTask || null;
      const kind = p.hookTaskKind || null;
      // 작업 시작뿐 아니라 작업 내용/종류(프롬프트↔작업)가 바뀔 때도 말풍선 갱신
      if (t.mode !== 'working' || t.task !== task || t.taskKind !== kind) {
        t.mode = 'working';
        t.task = task;
        t.taskKind = kind;
        if (sp) sp.setWorking(task, kind);
      }
    } else if (st === 'waiting') {
      t.idleSince = 0;
      if (t.mode !== 'waiting') { t.mode = 'waiting'; if (sp) sp.setWaiting(); }
    } else { // idle
      if (t.mode !== 'idle') {
        // 디바운스를 '벽시계 시간'으로 잰다. calm 카운터(폴링 횟수)는 패널 열기·새로고침 등
        // 추가 refreshProcs 호출로 조기 소진돼 진행 중 세션에 가짜 완료를 띄우던 문제가 있었다.
        if (!t.idleSince) t.idleSince = now;
        if (now - t.idleSince >= DONE_DEBOUNCE_MS) {
          const wasWorking = t.mode === 'working';
          t.mode = 'idle';
          t.idleSince = 0;
          if (sp) { if (wasWorking) sp.setDone(); else sp.goIdle(); }
        }
      }
    }
  }

  for (const [pid, t] of tracked) {
    if (!seen.has(pid)) {
      tracked.delete(pid);
      const sp = sessionPets.get(pid);
      if (sp) sp.farewell();
      myRunPids.delete(pid);
    }
  }
}

let injectableTtys = new Set(); // iTerm2/Terminal.app에 열려 있어 명령 주입이 가능한 tty

async function refreshProcs() {
  try {
    procs = await window.pet.listClaudeProcs();
  } catch { /* IPC 조회 실패 시 이전 목록 유지: 전 펫이 farewell됐다 재생성되며 가짜 완료가 뜨는 걸 방지 */ }
  try {
    injectableTtys = new Set(await window.pet.listInjectableTtys());
  } catch { injectableTtys = new Set(); }
  detectEvents();
  S.procBusy = [...tracked.values()].some(t => t.mode === 'working');
  updateBadge();
  renderProcs();
}

function updateBadge() {
  const n = procs.length;
  badgeEl.textContent = n;
  badgeEl.classList.toggle('show', n > 0);
  badgeEl.classList.toggle('busy', S.procBusy || S.working);
  $('#proc-count').textContent = n ? `(${n})` : '';
  if (S.state === 'idle') setAnim(S.working ? 'work' : 'idle');
}

let sendRowOpen = false; // 명령 입력 중엔 목록 재렌더링 중지

function renderProcs() {
  const list = $('#proc-list');
  if (!panelOpen || sendRowOpen) return;
  if (!procs.length) {
    list.innerHTML = '<div class="empty">실행 중인 Claude CLI가 없습니다 🍃</div>';
    return;
  }
  list.innerHTML = '';
  for (const p of procs) {
    const wrap = document.createElement('div');
    wrap.className = 'proc-wrap';
    const div = document.createElement('div');
    div.className = 'proc';
    const cwd = p.cwd || '(알 수 없음)';
    const short = cwd.replace(/^\/Users\/[^/]+/, '~');
    const mode = tracked?.get(p.pid)?.mode || 'idle';
    const label = mode === 'working' ? '작업 중' : mode === 'waiting' ? '입력 필요' : '대기';
    // cwd/etime/tty는 외부 프로세스에서 온 신뢰 불가 문자열이므로 innerHTML 대신
    // textContent로 넣는다 (디렉토리명에 HTML이 들어간 XSS→명령 실행 방지).
    const dot = document.createElement('div');
    dot.className = 'dot' + (mode === 'working' ? ' busy' : '') + (mode === 'waiting' ? ' wait' : '');
    const info = document.createElement('div');
    info.className = 'p-info';
    // 제목 = 세션 이름(myproj-e4 등), 없으면 cwd basename. cwd 전체는 hover 툴팁으로.
    const titleEl = document.createElement('div');
    titleEl.className = 'p-cwd';
    titleEl.title = cwd;   // 마우스 올리면 전체 cwd
    titleEl.textContent = p.sessionName || short;
    const meta = document.createElement('div');
    meta.className = 'p-meta';
    meta.textContent = `PID ${p.pid} · CPU ${p.cpu.toFixed(1)}% · ${p.etime}${p.tty ? ' · ' + p.tty : ''} · ${label}`;
    info.append(titleEl, meta);
    div.append(dot, info);

    if (cwd) {
      const send = document.createElement('button');
      send.className = 'btn small';
      send.textContent = '메시지';
      send.title = '이 세션에 메시지를 보냅니다 (크로스세션 — Warp 포함 모든 터미널에서 동작)';
      send.addEventListener('click', () => openSendRow(wrap, p, short, cwd));
      div.appendChild(send);
    }

    const kill = document.createElement('button');
    kill.className = 'btn danger small';
    kill.textContent = '종료';
    kill.addEventListener('click', async () => {
      if (!confirm(`PID ${p.pid} (${short}) 프로세스를 종료할까요?`)) return;
      const r = await window.pet.killProc(p.pid, false);
      if (!r.ok) alert('종료 실패: ' + r.error);
      setTimeout(refreshProcs, 400);
    });
    div.appendChild(kill);
    wrap.appendChild(div);
    list.appendChild(wrap);
  }
}

function openSendRow(wrap, p, name, cwd) {
  if (sendRowOpen) return;
  sendRowOpen = true;
  const row = document.createElement('div');
  row.className = 'send-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = `${name} 세션에 보낼 메시지… (Enter 전송, Esc 닫기)`;
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.textContent = '보내기';
  const close = () => { sendRowOpen = false; row.remove(); renderProcs(); };
  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    btn.disabled = true; btn.textContent = '전송 중…';
    // 크로스세션 메시징으로 전달 (Warp 포함). claude를 한 번 띄워 SendMessage하므로 몇 초 걸림.
    const r = await window.pet.sendToSession(cwd, p.sessionId || null, text);
    if (r.ok) {
      notify(`📨 ${r.name || name} — 메시지 전송`);
      close();
    } else {
      btn.disabled = false; btn.textContent = '보내기';
      alert(r.error);
    }
  };
  btn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) doSend();
    else if (e.key === 'Escape') close();
  });
  row.appendChild(input);
  row.appendChild(btn);
  wrap.appendChild(row);
  input.focus();
}

$('#refresh-procs').addEventListener('click', refreshProcs);
$('#refresh-usage').addEventListener('click', () => refreshUsage(true));
setInterval(refreshProcs, 1000);
// docs/form 폼 감지 (2초 주기) — 각 세션펫이 자기 cwd의 대기 폼을 확인
setInterval(() => { for (const sp of sessionPets.values()) sp.checkForms(); }, 2000);
// 사용량 HP바: 시작 시 1회 + 5분마다 갱신 (/usage는 콜드 스타트라 자주 안 부름)
refreshUsage(false);
setInterval(() => refreshUsage(false), 300000);

// ── 명령 실행 (claude -p) ────────────────────────────────────
const sessions = new Map(); // id -> { el, pre, prompt, done }

async function runPrompt() {
  const prompt = $('#prompt-input').value.trim();
  if (!prompt) return;
  const cwd = $('#cwd-input').value.trim() || undefined;
  const id = crypto.randomUUID();

  const el = document.createElement('div');
  el.className = 'session';
  const head = document.createElement('div');
  head.className = 's-head';
  const status = document.createElement('span');
  status.className = 's-status';
  status.textContent = '⏳';
  const promptEl = document.createElement('span');
  promptEl.className = 's-prompt';
  promptEl.title = prompt;
  promptEl.textContent = prompt; // 프롬프트에 '<' 등이 있어도 안전하게(그리고 깨지지 않게)
  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn ghost small';
  stopBtn.textContent = '중단';
  stopBtn.addEventListener('click', () => window.pet.stopRun(id));
  head.append(status, promptEl, stopBtn);
  const pre = document.createElement('pre');
  el.append(head, pre);
  $('#sessions').prepend(el);

  sessions.set(id, { el, pre, prompt, done: false });
  $('#prompt-input').value = '';

  const r = await window.pet.runClaude({ id, prompt, cwd });
  if (!r.ok) {
    finishSession(id, -1, r.error);
    return;
  }
  if (r.pid) myRunPids.add(r.pid);
  S.working = true;
  updateBadge();
  notify(`🏃 "${taskLabel(prompt)}" — 작업 시작`);
}

function taskLabel(prompt) {
  const one = prompt.replace(/\s+/g, ' ').trim();
  return one.length > 24 ? one.slice(0, 24) + '…' : one;
}

function finishSession(id, code, error) {
  const s = sessions.get(id);
  if (!s) return;
  s.done = true;
  s.el.querySelector('.s-status').textContent = code === 0 ? '✅' : '❌';
  const stopBtn = s.el.querySelector('button');
  if (stopBtn) stopBtn.remove();
  if (error) {
    const span = document.createElement('span');
    span.className = 'err';
    span.textContent = '\n' + error;
    s.pre.appendChild(span);
  }
  S.working = [...sessions.values()].some(x => !x.done);
  updateBadge();
  notify(code === 0
    ? `✅ "${taskLabel(s.prompt)}" — 작업 완료`
    : `❌ "${taskLabel(s.prompt)}" — 작업 실패`);
}

window.pet.onRunOutput(({ id, chunk, stderr }) => {
  const s = sessions.get(id);
  if (!s) return;
  if (stderr) {
    const span = document.createElement('span');
    span.className = 'err';
    span.textContent = chunk;
    s.pre.appendChild(span);
  } else {
    s.pre.appendChild(document.createTextNode(chunk));
  }
  s.pre.scrollTop = s.pre.scrollHeight;
});

window.pet.onRunDone(({ id, code, error }) => finishSession(id, code, error));

$('#run-btn').addEventListener('click', runPrompt);
$('#prompt-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runPrompt();
});

// ── 잡담 (대화 세션 유지) ────────────────────────────────────
let chatSessionId = localStorage.getItem('chatSessionId') || null;
let chatBusy = false;
const chatLog = $('#chat-log');
const chatInput = $('#chat-input');

function addMsg(cls, text) {
  const first = chatLog.querySelector('.empty');
  if (first) first.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || chatBusy) return;
  chatBusy = true;
  chatInput.value = '';
  addMsg('me', message);
  const thinking = addMsg('pet thinking', '생각 중… 🐾');
  setAnim('work');

  const r = await window.pet.chatClaude({ message, sessionId: chatSessionId });
  thinking.remove();
  chatBusy = false;
  if (S.state === 'idle') setAnim(S.working || S.procBusy ? 'work' : 'idle');

  if (!r.ok) {
    // 이전 세션을 못 찾는 경우 새 세션으로 한 번 재시도
    if (chatSessionId) {
      chatSessionId = null;
      localStorage.removeItem('chatSessionId');
      chatInput.value = message;
      addMsg('pet error', '이전 대화를 못 찾았어요. 다시 한 번 보내주세요!');
    } else {
      addMsg('pet error', '앗, 오류가 났어요: ' + (r.error || '알 수 없음'));
    }
    return;
  }
  if (r.sessionId) {
    chatSessionId = r.sessionId;
    localStorage.setItem('chatSessionId', chatSessionId);
  }
  addMsg('pet', r.reply);
  // 짧은 답이면 펫 말풍선으로도 보여준다
  if (r.reply.length <= 80) say(r.reply, 4000);
}

$('#chat-send').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) sendChat();
});
$('#chat-reset').addEventListener('click', () => {
  chatSessionId = null;
  localStorage.removeItem('chatSessionId');
  chatLog.innerHTML = '<div class="empty">새 대화를 시작해요 🐾</div>';
});

// ── 이미지 처리 (배경 제거 + 트림) ───────────────────────────
function processImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
     try {
      const MAX = 512;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, w, h);
      const im = cx.getImageData(0, 0, w, h);
      const d = im.data;

      // 이미 투명 픽셀이 있으면 배경 제거 생략
      let hasAlpha = false;
      for (let i = 3; i < d.length; i += 4 * 97) {
        if (d[i] < 250) { hasAlpha = true; break; }
      }

      if (!hasAlpha && S.bgRemove) {
        // 네 모서리 평균색을 배경색으로 보고, 가장자리에서 flood fill로 제거
        const corner = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
        const cs = [corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)];
        const bg = [0, 1, 2].map(k => cs.reduce((a, c) => a + c[k], 0) / 4);
        const TOL = 55;
        const isBg = (i) =>
          Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) < TOL;

        const visited = new Uint8Array(w * h);
        const stack = [];
        for (let x = 0; x < w; x++) { stack.push(x, x + (h - 1) * w); }
        for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
        while (stack.length) {
          const p = stack.pop();
          if (visited[p]) continue;
          visited[p] = 1;
          const i = p * 4;
          if (!isBg(i)) continue;
          d[i + 3] = 0;
          const x = p % w, y = (p / w) | 0;
          if (x > 0) stack.push(p - 1);
          if (x < w - 1) stack.push(p + 1);
          if (y > 0) stack.push(p - w);
          if (y < h - 1) stack.push(p + w);
        }
      }

      cx.putImageData(im, 0, 0);

      // 투명 여백 트림 (회전축은 하단중앙 고정이라 무게중심 계산은 불필요)
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
      if (maxX < 0) { resolve({ url: dataUrl, cx: 0.5, cy: 0.5 }); return; }
      const tw = maxX - minX + 1, th = maxY - minY + 1;
      const out = document.createElement('canvas');
      out.width = tw; out.height = th;
      out.getContext('2d').drawImage(cv, minX, minY, tw, th, 0, 0, tw, th);
      // 회전축 = 바닥중앙(50% 100%). "바닥에 점 찍고 그 점 기준으로 갸우뚱" = 바닥점 고정, 위에서 좌우로 기울기(역진자).
      // cx=0.5라 미러(scaleX)해도 축이 불변(좌우 안 튐). cy=1이라 바닥이 축.
      // ★ 단, 이것만으론 부족: 애니메이션의 translateY(바운스)가 캐릭터를 위아래로 들어올려 "바닥점이 위아래로 움직임".
      //   그래서 pet.html의 sp-* keyframe에서 translateY를 제거하고 바닥 기준 scaleY로 바꿨다(바닥 고정).
      resolve({ url: out.toDataURL('image/png'), cx: 0.5, cy: 1 });
     } catch { resolve({ url: dataUrl, cx: 0.5, cy: 1 }); } // 예외 시 원본으로 폴백(영구 pending 방지)
    };
    img.onerror = () => resolve({ url: dataUrl, cx: 0.5, cy: 1 });
    img.src = dataUrl;
  });
}

// 메인펫 기본 캐릭터 — 세션펫 아기새(defaultSpetIcon)의 성체 버전(어른새). 오른쪽을 본다.
function defaultSprite() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140">' +
    '<path d="M34 88 Q7 88 3 106 Q23 104 42 95 Z" fill="#b85c3e"/>' +               // 꼬리
    '<path d="M36 98 Q22 70 37 49 Q53 31 84 32 Q113 34 119 61 Q124 88 101 103 Q79 117 55 111 Q42 107 36 98 Z" fill="#d97757"/>' + // 몸통
    '<ellipse cx="70" cy="86" rx="26" ry="24" fill="#e8ab93"/>' +                    // 밝은 가슴
    '<path d="M56 57 Q84 49 103 64 Q95 88 66 90 Q50 75 56 57 Z" fill="#c46545"/>' +  // 접힌 날개
    '<path d="M62 66 Q80 61 94 70" stroke="#a9502f" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
    '<path d="M60 75 Q78 71 90 79" stroke="#a9502f" stroke-width="2.2" fill="none" stroke-linecap="round"/>' +
    '<path d="M90 30 Q104 12 118 13 Q107 25 99 34 Z" fill="#b85c3e"/>' +             // 볏
    '<circle cx="101" cy="53" r="9" fill="#fff"/><circle cx="104" cy="53" r="4.6" fill="#26211c"/>' +
    '<circle cx="106" cy="51" r="1.6" fill="#fff"/>' +                              // 눈 하이라이트
    '<path d="M113 56 L137 51 L113 66 Z" fill="#f2b705"/>' +                         // 부리
    '<path d="M113 61 L137 51 L125 64 Z" fill="#d99a04"/>' +
    '<path d="M62 111 L60 129 L53 130" stroke="#a9502f" stroke-width="4.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' + // 다리
    '<path d="M80 111 L82 129 L89 130" stroke="#a9502f" stroke-width="4.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

async function loadSprite(dataUrl) {
  spriteEl.src = (await processImage(dataUrl)).url;
}

async function initSprite() {
  const saved = await window.pet.getSavedImage();
  spriteEl.src = (await processImage(saved || defaultSprite())).url;
}
initSprite();

window.pet.onImageChanged((url) => loadSprite(url));

// 펫 위로 이미지 드래그&드롭
petEl.addEventListener('dragover', (e) => e.preventDefault());
petEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = async () => {
    await window.pet.saveImage(reader.result);
    loadSprite(reader.result);
    say('새 모습 어때요? ✨');
  };
  reader.readAsDataURL(file);
});

// ── 설정 ─────────────────────────────────────────────────────
$('#change-image').addEventListener('click', async () => {
  const url = await window.pet.pickImage();
  if (url) say('새 모습 어때요? ✨');
});

const sizeSlider = $('#size-slider'), sizeLabel = $('#size-label');
sizeSlider.value = S.size;
sizeLabel.textContent = S.size + 'px';
sizeSlider.addEventListener('input', () => {
  S.size = Number(sizeSlider.value);
  sizeLabel.textContent = S.size + 'px';
  localStorage.setItem('petSize', S.size);
  applySize();
});

const flipCheck = $('#flip-check');
flipCheck.checked = S.flip;
flipCheck.addEventListener('change', () => {
  S.flip = flipCheck.checked;
  localStorage.setItem('petFlip', S.flip ? '1' : '0');
});

const bgCheck = $('#bg-remove');
bgCheck.checked = S.bgRemove;
bgCheck.addEventListener('change', async () => {
  S.bgRemove = bgCheck.checked;
  localStorage.setItem('bgRemove', S.bgRemove ? '1' : '0');
  const saved = await window.pet.getSavedImage();
  if (saved) loadSprite(saved);
});

$('#quit-btn').addEventListener('click', () => window.pet.quit());

window.pet.getHome().then((home) => { $('#cwd-input').value = home; });
window.pet.onWorkAreaChanged(() => {
  S.x = clampX(S.x);
  if (S.state !== 'drag' && S.state !== 'fall') S.y = ground();
});

// 시작 인사
setTimeout(() => say('안녕하세요! 클릭하면 메뉴가 열려요 🐾', 4000), 800);
SPET_ICON = defaultSpetIcon();
refreshProcs();
