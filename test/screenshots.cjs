// README 스크린샷 생성기 (펫별 독립 창 구조) — 각 창 페이지를 스텁 preload로 띄워 투명 캡처 후 magick으로 어두운 배경에 합성.
//   npx electron test/screenshots.cjs   (ImageMagick `magick` 필요)
// 실제 앱/프로세스는 건드리지 않는다 (별도 userData, 스텁 preload). 이름은 전부 가상의 프로젝트.
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const { execFileSync } = require('child_process');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pets-shots-')));
app.on('window-all-closed', () => {}); // 창을 하나씩 열고 닫으므로 마지막 창이 닫혀도 종료하지 않는다 (없으면 다음 loadFile이 ERR_FAILED)
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pets-shots-tmp-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BG = '#19191b';
const wa = { x: 0, y: 0, width: 1100, height: 520 };

async function openPage(file, query, w, h) {
  const win = new BrowserWindow({ width: w, height: h, show: false, transparent: true, frame: false, webPreferences: { preload: path.join(__dirname, 'ui-preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '..', file), { query }); await sleep(350);
  return { win, js: (c) => win.webContents.executeJavaScript(c), shot: async (rect) => { await sleep(300); return win.webContents.capturePage(rect); } };
}
const meta = (id, provider, name, transport, extra) => Object.assign({ id, provider, transport: transport || 'cli', pid: 4101, cwd: '/Users/dev/work/' + name, tty: 'ttys002', name, sessionId: id }, extra || {});
// 펫 창을 하나 띄워 상태를 주고 캡처 (280×200 → 2x = 560×400)
async function petShot(m, state, opts) {
  const p = await openPage('pet-window.html', { id: m.id }, 280, 200);
  await p.js(`document.body.classList.add('shot'); window.smoke.fire(${JSON.stringify(Object.assign({ type: 'init', meta: m, wa, settings: { haloOn: true } }, state))})`);
  await sleep(200);
  if (opts && opts.then) await p.js(opts.then);
  await p.js(`(() => { const sp = document.querySelector('.spet'); if (!sp) return; const s = document.createElement('style'); s.textContent = '.spet .sbody, .spet .sbounce, .ssprite { animation: none !important; }'; document.head.appendChild(s); })()`);
  const img = await p.shot(); const f = path.join(TMP, m.id.replace(/[^a-z0-9]/gi, '_') + '.png'); fs.writeFileSync(f, img.toPNG()); p.win.destroy(); return f;
}
const magick = (args) => execFileSync('magick', args, { stdio: 'pipe' });
// 어두운 배경(W×H, 2x)에 (파일, x, y CSS px) 목록 합성
function compose(out, W, H, layers) {
  const args = ['-size', `${W * 2}x${H * 2}`, `xc:${BG}`];
  for (const [f, x, y] of layers) args.push(f, '-geometry', `+${x * 2}+${y * 2}`, '-composite');
  args.push(path.join(OUT, out)); magick(args); console.log('📸', out);
}

app.whenReady().then(async () => {
  try {
    // 1) 히어로: Claude·Codex 혼합 5마리 (작업 중 / 완료 / Codex CLI 작업 / Codex 데스크톱 입력 필요 / 입력 필요)
    const pets = [
      [meta('claude:1', 'claude', 'web-app-a1'), { state: 'working', task: 'src/App.tsx 수정 중', taskKind: 'tool' }],
      [meta('claude:2', 'claude', 'api-server-c7'), { state: 'idle' }, `window.smoke.fire({type:'working',task:'t'}); window.smoke.fire({type:'done'})`],
      [meta('codex:3', 'codex', 'docs-site-e4', 'cli'), { state: 'working', task: 'npm test 실행', taskKind: 'tool' }],
      [meta('codex:4', 'codex', 'data-pipeline-9f', 'desktop'), { state: 'waiting' }],
      [meta('claude:5', 'claude', 'mobile-app-b2'), { state: 'waiting' }],
    ];
    const files = [];
    for (const [m, st, then] of pets) files.push(await petShot(m, st, { then }));
    // 창 280 중 펫은 104px 위치 → 펫 좌표 xs에서 104를 빼 창 x
    const xs = [80, 290, 500, 710, 920];
    compose('session-pets.png', 1100, 220, files.map((f, i) => [f, xs[i] - 104, 20]));
    // 2) 알림 강조: 완료(초록 링) + 입력 필요(주황 링) — halo.html을 위상 고정으로 캡처해 펫 뒤에 합성
    const halo = async (kind) => { const h = await openPage('halo.html', { kind }, 600, 600); await h.js(`(() => { const s = document.createElement('style'); s.textContent = '#c i{animation-play-state:paused!important} #c i:nth-child(1){animation-delay:-.6s!important} #c i:nth-child(2){animation-delay:-.42s!important} #c i:nth-child(3){animation-delay:-.24s!important}'; document.head.appendChild(s); })()`); await sleep(500); const img = await h.shot(); const f = path.join(TMP, 'halo-' + kind + '.png'); fs.writeFileSync(f, img.toPNG()); h.win.destroy(); return f; };
    const hd = await halo('done'), hw = await halo('wait');
    // 펫 발 근처(창 안 좌표 137, 150) 중심 → 헤일로 창 600 중심 300
    compose('alert-halo.png', 1100, 340, [[hd, 260 + 137 - 300, 140 + 150 - 300], [hw, 720 + 137 - 300, 140 + 150 - 300], [files[1], 260, 140], [files[3], 720, 140]]);
    // 3) 우클릭 메뉴 (Codex 펫 + menu.html)
    const items = [{ id: 'focus', mark: '👀', label: '창 앞으로 가져오기' }, { id: 'folder', mark: '📁', label: 'Finder에서 작업 폴더 열기' }, { id: 'form-mode', mark: '📋', label: '폼 모드 켜기/끄기' }, { sep: true }, { id: 'image', mark: '🖼️', label: '이미지 변경…' }, { id: 'flip', mark: '↔️', label: '좌우 반전' }, { id: 'reset', mark: '🐾', label: '기본 모습으로' }];
    const mn = await openPage('menu.html', { items: JSON.stringify(items) }, 200, 260); const mimg = await mn.shot(); const mf = path.join(TMP, 'menu.png'); fs.writeFileSync(mf, mimg.toPNG()); mn.win.destroy();
    magick([mf, '-trim', '+repage', mf]);
    compose('context-menu.png', 600, 330, [[files[2], 40, 120], [mf, 210, 90]]);
    // 4) 패널 탭들
    const pn = await openPage('panel.html', {}, 460, 520);
    const panelShot = async (name) => { const img = await pn.shot(); fs.writeFileSync(path.join(TMP, name), img.toPNG()); magick([path.join(TMP, name), '-trim', '+repage', '-bordercolor', BG, '-border', '20', path.join(OUT, name)]); console.log('📸', name); };
    await pn.js(`window.smoke.setRows(${JSON.stringify([
      { id: 'claude:4101', provider: 'claude', pid: 4101, sessionName: 'web-app-a1', cwd: '/Users/dev/work/web-app-a1', tty: 'ttys002', cpu: 12.4, etime: '14:32', mode: 'working' },
      { id: 'claude:4102', provider: 'claude', pid: 4102, sessionName: 'api-server-c7', cwd: '/Users/dev/work/api-server-c7', tty: 'ttys003', cpu: 0.2, etime: '8:10', mode: 'idle' },
      { id: 'codex:1', provider: 'codex', transport: 'cli', pid: 5201, sessionId: 'd1a7f3e2-0000', sessionName: 'docs-site-e4', cwd: '/Users/dev/work/docs-site-e4', mode: 'working' },
      { id: 'codex:2', provider: 'codex', transport: 'desktop', pid: null, sessionId: 'd2a7f3e2-0000', sessionName: 'data-pipeline-9f', cwd: '/Users/dev/work/data-pipeline-9f', mode: 'waiting' },
      { id: 'claude:4105', provider: 'claude', pid: 4105, sessionName: 'mobile-app-b2', cwd: '/Users/dev/work/mobile-app-b2', tty: 'ttys005', cpu: 0.1, etime: '22:05', mode: 'waiting' },
    ])}); document.querySelector('[data-tab="procs"]').click();`); await sleep(400); await panelShot('procs-tab.png');
    await pn.js(`document.querySelector('[data-tab="settings"]').click()`); await panelShot('settings-tab.png');
    await pn.js(`providerSelect.value = 'codex'; providerSelect.dispatchEvent(new Event('change')); document.querySelector('[data-tab="usage"]').click();`); await sleep(500); await panelShot('usage-tab-codex.png');
    await pn.js(`providerSelect.value = 'claude'; providerSelect.dispatchEvent(new Event('change'));`); await sleep(500); await panelShot('usage-tab.png');
    pn.win.destroy();
    // 5) 메인펫 + HP바
    const mp = await openPage('main-pet.html', {}, 360, 266);
    await mp.js(`window.smoke.fire(${JSON.stringify({ type: 'init', wa })})`); await sleep(900);
    await mp.js(`(() => { const s = document.createElement('style'); s.textContent = '#sprite-wrap, .msprite { animation: none !important; } #bubble { display:none !important; }'; document.head.appendChild(s); })()`);
    const mimg2 = await mp.shot(); const mpf = path.join(TMP, 'main.png'); fs.writeFileSync(mpf, mimg2.toPNG()); mp.win.destroy();
    magick([mpf, '-trim', '+repage', '-bordercolor', BG, '-border', '30', path.join(OUT, 'mainpet-hp.png')]); console.log('📸 mainpet-hp.png');
    app.exit(0);
  } catch (e) { console.error('SHOT_FAIL', e.stack || e.message); app.exit(1); }
});
