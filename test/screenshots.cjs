// README 스크린샷 생성기 — 더미 세션 데이터로 pet.html을 렌더해 docs/screenshots/*.png를 찍는다.
//   npx electron test/screenshots.cjs            # 전부 갱신
//   SHOTS=hero,procs npx electron test/screenshots.cjs
// 실제 앱/프로세스는 건드리지 않는다 (별도 userData, 스텁 preload).
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pets-shots-')));
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const only = process.env.SHOTS ? new Set(process.env.SHOTS.split(',')) : null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 더미 세션 (이름은 전부 가상의 프로젝트)
const claude = (pid, name, tty, cpu, etime, hookState, task, taskKind) => ({
  id: 'claude:' + pid, provider: 'claude', pid, sessionId: 'c' + pid + '0000-0000-4000-8000-000000000000', sessionName: name,
  cwd: '/Users/dev/work/' + name, tty, cpu, cpusec: 0, etime, hookState, hookAge: 0, task, taskKind,
});
const codex = (n, name, transport, state, task) => ({
  id: 'codex:' + n, provider: 'codex', pid: transport === 'cli' ? 5200 + n : null, transport, state, task,
  sessionId: 'd' + n + 'a7f3e2-0000-4000-8000-000000000000', sessionName: name, cwd: '/Users/dev/work/' + name, cpu: 0, cpusec: 0, etime: '0:00',
});
const ROWS = [
  claude(4101, 'web-app-a1', 'ttys002', 12.4, '14:32', 'working', 'src/App.tsx 수정 중', 'tool'),
  claude(4102, 'api-server-c7', 'ttys003', 0.2, '8:10', 'idle'),
  codex(1, 'docs-site-e4', 'cli', 'working', 'npm test 실행'),
  codex(2, 'data-pipeline-9f', 'desktop', 'waiting'),
  claude(4105, 'mobile-app-b2', 'ttys005', 0.1, '22:05', 'waiting'),
];

async function main() {
  const win = new BrowserWindow({ width: 1100, height: 520, show: false, transparent: false, backgroundColor: '#19191b',
    webPreferences: { preload: path.join(__dirname, 'screenshots-preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '..', 'pet.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`window.shot.setRows(${JSON.stringify(ROWS)}); document.body.style.background='#19191b';`);
  await js(`refreshProcs()`); await sleep(400);
  // 배치: 화면 하단에 일렬로. 메인펫은 오른쪽 끝에.
  await js(`(() => {
    const ids = ${JSON.stringify(ROWS.map(r => r.id))};
    const xs = [80, 290, 500, 710, 920];
    ids.forEach((id, i) => { const sp = sessionPets.get(id); if (!sp) return; sp.x = xs[i]; sp.y = sp.groundY(); sp.targetX = null; sp.dir = 1; sp.stateUntil = performance.now() + 1e9; sp.render(); });
    petEl.style.display = 'none';
    const done = sessionPets.get('claude:4102'); done.setWorking('t'); done.setDone();
    document.getElementById('hpbars').style.display = 'none';
  })()`);
  const shoot = async (name, rect) => {
    if (only && !only.has(name)) return;
    await sleep(350);
    const img = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    console.log('📸', name, img.getSize());
  };
  const petsRect = async () => { const b = await js(`(() => { const ys = [...sessionPets.values()].map(s => s.el.getBoundingClientRect().top - 70); return Math.max(0, Math.floor(Math.min(...ys))); })()`); return { x: 0, y: b, width: 1100, height: 520 - b }; };

  // 1) 히어로: Claude + Codex 혼합 세션펫 (작업 중 · 완료 · Codex CLI 작업 · Codex 데스크톱 입력 필요 · 입력 필요)
  await js(`document.body.classList.add('no-halo')`);
  await shoot('session-pets', await petsRect());
  await js(`document.body.classList.remove('no-halo')`);
  // 2) 알림 강조: 완료(초록 링·점프) + 입력 필요(주황 링). 링 애니메이션은 잘 보이는 위상에서 멈춰 찍는다.
  await js(`(() => { for (const sp of sessionPets.values()) sp.el.style.display = (sp.id === 'claude:4102' || sp.id === 'codex:2') ? '' : 'none';
    const a = sessionPets.get('claude:4102'), b = sessionPets.get('codex:2'); a.x = 260; b.x = 720; a.render(); b.render();
    const st = document.createElement('style'); st.id = 'shot-freeze'; st.textContent = '.spet.alerting .shalo i{animation-play-state:paused!important} .spet.alerting .shalo i:nth-child(1){animation-delay:-.6s!important} .spet.alerting .shalo i:nth-child(2){animation-delay:-.42s!important} .spet.alerting .shalo i:nth-child(3){animation-delay:-.24s!important}'; document.head.appendChild(st); })()`);
  await sleep(600);
  await shoot('alert-halo', { x: 0, y: 150, width: 1100, height: 370 });
  await js(`document.getElementById('shot-freeze').remove(); for (const sp of sessionPets.values()) sp.el.style.display = ''`);
  // 3) 우클릭 메뉴 (Codex 펫 — 폼 모드 항목 포함)
  await js(`(() => { for (const sp of sessionPets.values()) sp.el.style.display = sp.id === 'codex:1' ? '' : 'none';
    const sp = sessionPets.get('codex:1'); sp.x = 120; sp.render(); const r = sp.el.getBoundingClientRect();
    sp.el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right + 4, clientY: r.top + 30 })); })()`);
  await shoot('context-menu', { x: 0, y: 160, width: 600, height: 360 });
  await js(`closeSpetMenu(); for (const sp of sessionPets.values()) sp.el.style.display = ''`);
  // 4) 패널 탭들 — 목록(Claude·Codex 혼합) / 설정 / Codex 사용량
  const panelRect = async () => { const r = await js(`(() => { const b = document.getElementById('panel').getBoundingClientRect(); return { x: Math.floor(b.left) - 10, y: Math.floor(b.top) - 10, width: Math.ceil(b.width) + 20, height: Math.ceil(b.height) + 20 }; })()`); return r; };
  await js(`for (const sp of sessionPets.values()) sp.el.style.display = 'none'; showPanel(); document.getElementById('panel').style.left = '20px'; document.getElementById('panel').style.top = '20px'; document.getElementById('panel').style.bottom = 'auto'; document.querySelector('[data-tab="procs"]').click(); renderProcs();`);
  await sleep(300);
  await shoot('procs-tab', await panelRect());
  await js(`document.querySelector('[data-tab="settings"]').click()`);
  await shoot('settings-tab', await panelRect());
  await js(`providerSelect.value = 'codex'; providerSelect.dispatchEvent(new Event('change')); document.querySelector('[data-tab="usage"]').click(); refreshUsage(true);`);
  await sleep(500);
  await shoot('usage-tab-codex', await panelRect());
  await js(`providerSelect.value = 'claude'; providerSelect.dispatchEvent(new Event('change')); refreshUsage(true);`);
  await sleep(500);
  await shoot('usage-tab', await panelRect());
  // 5) 메인펫 + HP바 (5h 세션 / 주간)
  await js(`document.getElementById('panel').style.display = 'none'; petEl.style.display = ''; document.getElementById('hpbars').style.display = ''; document.getElementById('bubble').style.display = 'none'; S.x = 450; S.y = ground() - 28; S.stateUntil = performance.now() + 1e9; petEl.style.transform = 'translate(' + S.x + 'px,' + S.y + 'px)'; refreshUsage(true);`);
  await sleep(600);
  const pr = await js(`(() => { const b = petEl.getBoundingClientRect(); const y = Math.max(0, Math.floor(b.top) - 50); return { x: Math.max(0, Math.floor(b.left) - 60), y, width: Math.ceil(b.width) + 120, height: 520 - y }; })()`);
  console.log('mainpet rect', pr);
  await shoot('mainpet-hp', pr);
  app.quit();
}
app.whenReady().then(() => main().catch(e => { console.error(e); app.exit(1); }));
