/* Claude Session Pets — 도트(픽셀) 기본 캐릭터 렌더러: 부엉이 가족
 *
 * 기본 캐릭터는 이미지 파일이 아니라 여기서 프레임 단위로 캔버스에 그린다.
 *  - 아기 부엉(chick, 24×30 그리드·위 4행은 이펙트 여백): 세션펫 기본. 3x = 72×90px
 *  - 어미 부엉(mother, 30×34 그리드): 메인펫 기본. 4x = 120×136px (round(S.size/32) 정수 배율)
 * 정면(치비: 큰 머리·아주 큰 눈·귀깃)이 기본 시점이고, **걷기(walk)만 옆모습** 스프라이트를 쓴다
 * (좌우 방향은 pet.js render()가 scaleX로 반전). 픽셀 프레임은 12fps로 그리고,
 * 점프/갸우뚱/늘썩/착지 스쿼시는 기존 CSS 모션(.sbody/.sbounce/#pet.anim-*)이 그대로 담당한다.
 * 그리드 바닥(마지막 행)이 발 = 회전축(50% 100%)과 일치하도록 그린다.
 * 커스텀 이미지를 지정한 펫은 이 렌더러를 쓰지 않는다(기존 <img> 경로 유지).
 */
(function () {
  'use strict';

  // ── 팔레트 (인덱스 → 색). 1 외곽선 2 몸 3 하이라이트 4 배·얼굴(크림) 5 부리 6 부리 그늘 7 눈 흰자 8 눈동자 9 볼
  //    10 발 11 몸 그늘(날개 줄) 12/13 스카프 14 Z 15 흰 반짝 16 노트북 그늘 17 노트북 18 화면 19 비트 스파크 20~ 색종이
  const COMMON = { 5: '#f7c94b', 6: '#c98f1c', 7: '#ffffff', 8: '#2a1b18', 10: '#d9a133', 14: '#8fb3ff', 15: '#ffffff', 16: '#2f3340', 17: '#5d6270', 18: '#8fd3ff', 19: '#ffd76a', 20: '#f7c94b', 21: '#ff9a8a', 22: '#8fd3ff', 23: '#8b95f3', 24: '#7fc8b0', 25: '#e8e6de' };
  const PAL = {
    // 클로드 오렌지 (Claude 세션 · 메인펫). 스카프는 민트
    claude: Object.assign({}, COMMON, { 1: '#5a2717', 2: '#e8865f', 3: '#f7b592', 4: '#fbe7d3', 9: '#ff9a8a', 11: '#c9663f', 12: '#7fc8b0', 13: '#5aa892' }),
    // 페리윙클(하늘~보라) — Codex 세션. 스카프는 노랑
    codex: Object.assign({}, COMMON, { 1: '#2a2c70', 2: '#8b95f3', 3: '#c1c7ff', 4: '#eef0ff', 9: '#ffa3d1', 11: '#6b74d6', 12: '#ffd27f', 13: '#e0ac4f' }),
  };
  const CODEX_ACCENT = PAL.codex[2];

  const inC = (x, y, cx, cy, r) => { const dx = x + .5 - cx, dy = y + .5 - cy; return dx * dx + dy * dy <= r * r; };
  const inE = (x, y, cx, cy, rx, ry) => { const dx = (x + .5 - cx) / rx, dy = (y + .5 - cy) / ry; return dx * dx + dy * dy <= 1; };
  const blink = (t, period, at) => ((t + at) % period) < 0.14;
  const makeGrid = (W, H) => Array.from({ length: H }, () => new Array(W).fill(0));
  const setter = (g, W, H, oy) => (x, y, c) => { y += oy || 0; if (x >= 0 && x < W && y >= 0 && y < H) g[y][x] = c; };
  const each = (pts, fn) => pts.forEach(([x, y]) => fn(x, y));

  // 실루엣(원의 합집합) 채우기 + 외곽선. fill(x,y)로 안쪽 색 결정
  function silhouette(set, W, H, circles, fill) {
    const inside = (x, y) => circles.some(c => inC(x, y, c[0], c[1], c[2]));
    for (let y = -4; y < H; y++) for (let x = 0; x < W; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1);
      set(x, y, edge ? 1 : fill(x, y));
    }
  }
  // 외곽선 있는 타원(날개). bars: 그늘 줄을 넣을 (y - cy) 오프셋 목록
  function ovalWing(set, cx, cy, rx, ry, bars) {
    for (let y = Math.floor(cy - ry) - 1; y <= cy + ry + 1; y++) for (let x = Math.floor(cx - rx) - 1; x <= cx + rx + 1; x++) {
      if (!inE(x, y, cx, cy, rx, ry)) continue;
      const e = !inE(x + 1, y, cx, cy, rx, ry) || !inE(x - 1, y, cx, cy, rx, ry) || !inE(x, y + 1, cx, cy, rx, ry) || !inE(x, y - 1, cx, cy, rx, ry);
      set(x, y, e ? 1 : (bars.includes(y - Math.floor(cy)) && x > cx - rx + 1.5 && x < cx + rx - 1.5 ? 11 : 2));
    }
  }
  // 부엉이 눈: 어두운 테 + 흰자 + 눈동자(px,py로 시선). kind: open|wide|closed|happy
  function owlEye(set, cx, cy, ring, white, pupil, kind, px, py) {
    for (let y = Math.floor(cy - ring) - 1; y <= cy + ring + 1; y++) for (let x = Math.floor(cx - ring) - 1; x <= cx + ring + 1; x++) if (inE(x, y, cx, cy, ring, ring)) set(x, y, inE(x, y, cx, cy, white, white) ? 7 : 1);
    const w = Math.floor(white);
    if (kind === 'closed') { for (let x = Math.ceil(cx - w); x < cx + w; x++) set(x, Math.floor(cy), 1); return; }
    if (kind === 'happy') { const y0 = Math.floor(cy) - 1; set(Math.ceil(cx - w), y0 + 1, 1); set(Math.ceil(cx - w) + 1, y0, 1); for (let x = Math.ceil(cx - w) + 2; x < cx + w - 2; x++) set(x, y0 - (w > 3 ? 1 : 0), 1); set(Math.floor(cx + w) - 2, y0, 1); set(Math.floor(cx + w) - 1, y0 + 1, 1); return; }
    const s = kind === 'wide' ? pupil * 0.62 : pupil;
    const ex = cx + (px || 0), ey = cy + (py || 0);
    for (let y = Math.floor(ey - s) - 1; y <= ey + s + 1; y++) for (let x = Math.floor(ex - s) - 1; x <= ex + s + 1; x++) if (inE(x, y, ex, ey, s, s + .3)) set(x, y, 8);
    set(Math.floor(ex) - 1, Math.floor(ey) - 1, 15); if (pupil > 1.8) set(Math.floor(ex) + 1, Math.floor(ey) + 1, 15);
  }
  // 발: 2px 폭 + 발가락 행(4px). lift면 발가락 없이 한 칸
  function foot(set, x, top, lift, side) {
    set(x, top, 10); set(x + 1, top, 10);
    if (lift) return;
    if (side) { set(x, top + 1, 10); set(x + 1, top + 1, 10); set(x + 2, top + 1, 10); set(x + 3, top + 1, 10); }
    else { set(x - 1, top + 1, 10); set(x, top + 1, 10); set(x + 1, top + 1, 10); set(x + 2, top + 1, 10); }
  }

  // ── 아기 부엉 (세션펫) 24×30, 그림 원점 OY=4 ──
  const CW = 24, CH = 30, COY = 4;
  const P0 = { eye: 'open', px: 0, py: 0, wingDy: 0, legL: 0, legR: 0, liftL: 0, liftR: 0, ear: 0 };
  // 정면
  function chickFront(p) {
    p = Object.assign({}, P0, p); const g = makeGrid(CW, CH), set = setter(g, CW, CH, COY);
    silhouette(set, CW, 26, [[12, 14, 9.4]], (x, y) => inE(x, y, 12, 18, 5.2, 4.6) ? 4 : (inC(x, y, 8, 8, 2.6) ? 3 : 2));
    const e = p.ear; // 귀깃(양쪽 삼각) — ear로 살짝 들썩
    each([[4, 5], [5, 4], [6, 3], [5, 5], [6, 4], [6, 5], [7, 4]], (x, y) => set(x, y - e, 2)); each([[3, 5], [4, 4], [5, 3], [6, 2], [7, 3]], (x, y) => set(x, y - e, 1));
    each([[19, 5], [18, 4], [17, 3], [18, 5], [17, 4], [17, 5], [16, 4]], (x, y) => set(x, y - e, 2)); each([[20, 5], [19, 4], [18, 3], [17, 2], [16, 3]], (x, y) => set(x, y - e, 1));
    owlEye(set, 7.5, 10.5, 3.6, 2.7, 1.6, p.eye, p.px, p.py); owlEye(set, 16.5, 10.5, 3.6, 2.7, 1.6, p.eye, p.px, p.py);
    set(12, 12, 5); set(11, 13, 5); set(12, 13, 5); set(12, 14, 6); // 부리
    set(4, 14, 9); set(19, 14, 9); // 볼
    const wy = 16 + p.wingDy; for (let y = wy; y < wy + 4; y++) { set(4, y, 11); set(19, y, 11); } // 날개 무늬
    foot(set, 8 + p.legL, 24, p.liftL, false); foot(set, 14 + p.legR, 24, p.liftR, false);
    return g;
  }
  // 옆모습(오른쪽 보기) — 걷기용
  function chickSide(p) {
    p = Object.assign({}, P0, p); const g = makeGrid(CW, CH), set = setter(g, CW, CH, COY);
    silhouette(set, CW, 26, [[12, 14, 9.4]], (x, y) => inE(x, y, 14.5, 18.5, 4.6, 4.4) ? 4 : (inC(x, y, 8, 8, 2.6) ? 3 : 2));
    each([[7, 5], [8, 4], [8, 5], [9, 5]], (x, y) => set(x, y, 2)); each([[6, 5], [7, 4], [8, 3], [9, 4]], (x, y) => set(x, y, 1));
    each([[15, 5], [16, 4], [16, 5], [17, 3], [17, 4], [17, 5], [18, 5]], (x, y) => set(x, y, 2)); each([[14, 5], [15, 4], [16, 3], [17, 2], [18, 3], [18, 4], [19, 5]], (x, y) => set(x, y, 1));
    owlEye(set, 16, 10.5, 3.8, 2.9, 1.6, p.eye, p.px + 0.6, p.py);
    set(21, 12, 5); set(22, 12, 5); set(21, 13, 6); set(23, 12, 6); set(20, 14, 9);
    ovalWing(set, 7.5, 16 + p.wingDy, 4.2, 4.4, [-1, 1]);
    each([[2, 19], [1, 20], [2, 20], [1, 21], [2, 21], [3, 21]], (x, y) => set(x, y, 11)); each([[1, 19], [0, 20], [0, 21], [0, 22], [1, 22], [2, 22], [3, 22]], (x, y) => set(x, y, 1)); // 꼬리
    foot(set, 8 + p.legL, 24, p.liftL, true); foot(set, 13 + p.legR, 24, p.liftR, true);
    return g;
  }
  const FX = {
    laptop: (g, t, W, H, x0, y0, tall) => { const set = setter(g, W, H, 0); // 오른쪽 아래 노트북(옆에서 본 모양) + 화면에서 솟는 비트
      for (let x = x0; x <= W - 1; x++) { set(x, H - 3, 17); set(x, H - 2, 16); }
      for (let y = y0; y <= H - 4; y++) { set(W - 3, y, 17); set(W - 2, y, 18); set(W - 1, y, 17); }
      set(W - 2, y0, 17); set(W - 2, H - 4, 17);
      for (let i = 0; i < 3; i++) { const y = y0 - 1 - Math.floor(((t * 6) + i * 5) % tall); set(W - 3 + (i % 3), y, 19); } },
    confetti: (g, t, W, H) => { const set = setter(g, W, H, 0); const cols = [20, 21, 22, 23, 24, 9, 5];
      for (let i = 0; i < 9; i++) { const x = (i * 7 + 3) % W; const y = Math.floor((t * 9 + i * 4.3) % (H - 4)); set(x, y, cols[i % cols.length]); } },
    question: (g, t) => { const set = setter(g, CW, CH, 0); const bob = Math.floor(t * 3) % 2, ox = 19, oy = bob;
      each([[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [1, 4]], (x, y) => set(ox + x, oy + y, 19)); },
    dust: (g, dt, W, H, lx, rx) => { const set = setter(g, W, H, 0); const s = Math.floor(dt * 6);
      each([[lx - s, H - 1], [lx - 1 - s, H - 2 - Math.min(s, 1)], [rx + s, H - 1], [rx + 1 + s, H - 2 - Math.min(s, 1)]], (x, y) => set(x, y, 25)); },
  };
  const WALK = [{ legL: -1, legR: 1 }, { liftL: 1 }, { legL: 1, legR: -1 }, { liftR: 1 }];
  const look = (t, period, from, to) => ((t % period) > from && (t % period) < to);
  // 상태 → t(초) 시점의 프레임. dt = 상태 진입 후 경과초
  const CHICK = {
    idle: (t) => chickFront({ eye: blink(t, 3.4, 0) ? 'closed' : 'open', px: look(t, 7, 4.2, 5.6) ? 1 : (look(t, 7, 1.5, 2.3) ? -1 : 0), ear: Math.sin(t * 2.1) > .8 ? 1 : 0 }),
    walk: (t) => { const ph = Math.floor(t * 8) % 4; return chickSide(Object.assign({ wingDy: ph % 2, eye: blink(t, 4.1, 1) ? 'closed' : 'open' }, WALK[ph])); },
    work: (t) => { const g = chickFront({ px: 1, py: 1, eye: blink(t, 5, 2) ? 'closed' : 'open', wingDy: Math.floor(t * 10) % 2 }); FX.laptop(g, t, CW, CH, 16, 22, 12); return g; },
    done: (t) => { const g = chickFront({ eye: 'happy', wingDy: -2 + Math.floor(t * 6) % 2, ear: Math.floor(t * 6) % 2 }); FX.confetti(g, t, CW, CH); return g; },
    wait: (t) => { const g = chickFront({ px: 1, py: -1, liftR: Math.floor(t * 4) % 2, eye: blink(t, 3, 0) ? 'closed' : 'open' }); FX.question(g, t); return g; },
    drag: (t) => chickFront({ eye: 'wide', legL: -2, legR: 2, liftL: Math.floor(t * 5) % 2, liftR: (Math.floor(t * 5) + 1) % 2, wingDy: -3 + Math.floor(t * 8) % 2 }),
    fall: (t) => chickFront({ eye: 'wide', wingDy: -3, legL: -1, legR: 1 }),
    land: (t, dt) => { const g = chickFront({}); if (dt < 0.5) FX.dust(g, dt, CW, CH, 6, 17); return g; },
    bye: (t) => chickFront({ eye: 'happy', wingDy: -3 + Math.floor(t * 8) % 2, ear: 1 }),
  };

  // ── 어미 부엉 (메인펫) 30×34 — 아기보다 확실히 크고, 긴 귀깃·속눈썹·스카프·깃 줄 3 ──
  const MW = 30, MH = 34;
  const M0 = { eye: 'open', px: 0, py: 0, wingDy: 0, legL: 0, legR: 0, liftL: 0, liftR: 0, droop: 0 };
  function motherFront(p) {
    p = Object.assign({}, M0, p); const g = makeGrid(MW, MH), set = setter(g, MW, MH, 0);
    silhouette(set, MW, MH, [[15, 19, 12.2]], (x, y) => inE(x, y, 15, 24, 6.4, 5.8) ? 4 : (inC(x, y, 10, 11, 3.4) ? 3 : 2));
    const d = p.droop; // 잠들면 귀깃이 처진다
    each([[4, 8], [5, 7], [6, 6], [7, 5], [5, 8], [6, 7], [7, 6], [8, 5], [6, 8], [7, 7], [8, 6], [7, 8], [8, 7], [8, 8]], (x, y) => set(x, y + d, 2)); each([[3, 8], [4, 7], [5, 6], [6, 5], [7, 4], [8, 4], [9, 5], [9, 6]], (x, y) => set(x, y + d, 1));
    each([[25, 8], [24, 7], [23, 6], [22, 5], [24, 8], [23, 7], [22, 6], [21, 5], [23, 8], [22, 7], [21, 6], [22, 8], [21, 7], [21, 8]], (x, y) => set(x, y + d, 2)); each([[26, 8], [25, 7], [24, 6], [23, 5], [22, 4], [21, 4], [20, 5], [20, 6]], (x, y) => set(x, y + d, 1));
    owlEye(set, 9, 13.5, 4.6, 3.5, 2.1, p.eye, p.px, p.py); owlEye(set, 21, 13.5, 4.6, 3.5, 2.1, p.eye, p.px, p.py);
    set(4, 9, 1); set(5, 8, 1); set(25, 9, 1); set(24, 8, 1); // 속눈썹
    set(15, 16, 5); set(14, 17, 5); set(15, 17, 5); set(16, 17, 5); set(15, 18, 6);
    set(3, 19, 9); set(4, 19, 9); set(26, 19, 9); set(25, 19, 9);
    for (let x = 8; x <= 22; x++) { set(x, 20, 12); set(x, 21, 13); } set(21, 22, 12); set(22, 22, 12); set(22, 23, 13); set(23, 23, 12); set(23, 24, 13); // 스카프
    const wy = 23 + p.wingDy; for (let y = wy; y < wy + 6; y++) { set(4, y, 11); set(25, y, 11); if (y % 2) { set(5, y, 11); set(24, y, 11); } }
    foot(set, 10 + p.legL, 32, p.liftL, false); foot(set, 18 + p.legR, 32, p.liftR, false);
    return g;
  }
  function motherSide(p) {
    p = Object.assign({}, M0, p); const g = makeGrid(MW, MH), set = setter(g, MW, MH, 0);
    silhouette(set, MW, MH, [[15, 19, 12.2]], (x, y) => inE(x, y, 18.5, 25, 6, 5.6) ? 4 : (inC(x, y, 10, 11, 3.4) ? 3 : 2));
    each([[8, 7], [9, 6], [9, 7], [10, 7], [10, 6]], (x, y) => set(x, y, 2)); each([[7, 7], [8, 6], [9, 5], [10, 5], [11, 6]], (x, y) => set(x, y, 1));
    each([[19, 7], [20, 6], [20, 7], [21, 5], [21, 6], [21, 7], [22, 6], [22, 7], [23, 7]], (x, y) => set(x, y, 2)); each([[18, 7], [19, 6], [20, 5], [21, 4], [22, 4], [22, 5], [23, 6], [24, 7]], (x, y) => set(x, y, 1));
    owlEye(set, 20.5, 13.5, 4.8, 3.6, 2.1, p.eye, p.px + 0.7, p.py);
    set(16, 9, 1); set(25, 9, 1); set(26, 10, 1);
    set(27, 15, 5); set(28, 15, 5); set(29, 15, 6); set(27, 16, 6); set(28, 16, 6); set(26, 18, 9);
    for (let x = 6; x <= 24; x++) if (inC(x, 20, 15, 19, 12.2)) { set(x, 20, 12); set(x, 21, 13); } set(23, 22, 12); set(24, 22, 12); set(24, 23, 13); set(25, 23, 12); set(25, 24, 13);
    ovalWing(set, 9, 25 + p.wingDy, 5.4, 5.4, [-2, 0, 2]);
    each([[2, 26], [1, 27], [2, 27], [1, 28], [2, 28], [3, 28], [1, 29], [2, 29], [3, 29]], (x, y) => set(x, y, 11)); each([[1, 26], [0, 27], [0, 28], [0, 29], [0, 30], [1, 30], [2, 30], [3, 30], [4, 30]], (x, y) => set(x, y, 1));
    foot(set, 10 + p.legL, 32, p.liftL, true); foot(set, 17 + p.legR, 32, p.liftR, true);
    return g;
  }
  const MOTHER = {
    idle: (t) => motherFront({ eye: blink(t, 3.9, 0.7) ? 'closed' : 'open', px: look(t, 9, 5, 6.5) ? 1 : (look(t, 9, 2, 2.8) ? -1 : 0) }),
    walk: (t) => { const ph = Math.floor(t * 7) % 4; return motherSide(Object.assign({ wingDy: ph % 2, eye: blink(t, 4.4, 1) ? 'closed' : 'open' }, WALK[ph])); },
    work: (t) => { const g = motherFront({ px: 1, py: 1, eye: blink(t, 5, 2) ? 'closed' : 'open', wingDy: Math.floor(t * 10) % 2 }); FX.laptop(g, t, MW, MH, 21, 24, 14); return g; },
    sleep: (t) => motherFront({ eye: 'closed', droop: 2, wingDy: 1 }),
    drag: (t) => motherFront({ eye: 'wide', legL: -2, legR: 2, liftL: Math.floor(t * 5) % 2, liftR: (Math.floor(t * 5) + 1) % 2, wingDy: -3 + Math.floor(t * 8) % 2 }),
    fall: (t) => motherFront({ eye: 'wide', wingDy: -3, legL: -1, legR: 1 }),
    land: (t, dt) => { const g = motherFront({}); if (dt < 0.5) FX.dust(g, dt, MW, MH, 7, 22); return g; },
  };

  function paint(canvas, g, pal, scale) {
    const W = g[0].length, H = g.length, s = scale || 1;
    if (canvas.width !== W * s || canvas.height !== H * s) { canvas.width = W * s; canvas.height = H * s; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = g[y][x]; if (!c) continue; ctx.fillStyle = pal[c] || '#f0f'; ctx.fillRect(x * s, y * s, s, s); }
  }

  // ── 살아있는 스프라이트: 상태를 받아 12fps로 캔버스를 갱신 ──
  const FPS = 12;
  const live = new Set();
  class DotSprite {
    constructor(canvas, kind, pal, scale) {
      this.canvas = canvas; this.kind = kind; this.pal = pal || 'claude';
      this.state = 'idle'; this.stateSince = 0; this.lastFrame = -1;
      this.canvas.style.imageRendering = 'pixelated';
      this.setScale(scale || (kind === 'mother' ? 4 : 3));
      live.add(this);
      this.draw(performance.now() / 1000, true);
    }
    get W() { return this.kind === 'mother' ? MW : CW; }
    get H() { return this.kind === 'mother' ? MH : CH; }
    setScale(s) { this.scale = Math.max(1, Math.round(s)); this.canvas.style.width = (this.W * this.scale) + 'px'; this.canvas.style.height = (this.H * this.scale) + 'px'; this.lastFrame = -1; }
    setPalette(name) { if (PAL[name] && name !== this.pal) { this.pal = name; this.lastFrame = -1; } }
    setState(s) {
      const table = this.kind === 'mother' ? MOTHER : CHICK;
      if (!table[s]) s = 'idle';
      if (s === this.state) return;
      if (this.state === 'fall' && s !== 'drag') s = 'land'; // fall → 다른 상태 = 착지: 잠깐 흙먼지
      this.state = s; this.stateSince = performance.now() / 1000; this.lastFrame = -1;
    }
    draw(t, force) {
      const frame = Math.floor(t * FPS);
      if (!force && frame === this.lastFrame) return;
      this.lastFrame = frame;
      const table = this.kind === 'mother' ? MOTHER : CHICK;
      const dt = t - this.stateSince;
      if (this.state === 'land' && dt > 0.6) this.state = 'idle';
      const f = table[this.state] || table.idle;
      paint(this.canvas, f(t, dt), PAL[this.pal] || PAL.claude, this.scale);
    }
    destroy() { live.delete(this); }
    static tickAll(nowMs) { const t = nowMs / 1000; for (const s of live) s.draw(t, false); }
    // 정지 프레임 (아이콘·목업·시트용)
    static frame(kind, state, t) { const table = kind === 'mother' ? MOTHER : CHICK; return (table[state] || table.idle)(t || 0, 0.2); }
  }

  window.DotSprites = { DotSprite, PAL, paint, CODEX_ACCENT, CHICK_SIZE: [CW, CH], MOTHER_SIZE: [MW, MH], STATES: { chick: Object.keys(CHICK), mother: Object.keys(MOTHER) } };
})();
