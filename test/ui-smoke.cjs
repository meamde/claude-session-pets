// 새 구조(펫별 독립 창) UI 스모크: pet-window.html / main-pet.html / panel.html을 스텁 preload로 띄워 상태 전이·렌더를 확인
const { app, BrowserWindow } = require('electron'); const path = require('path'), fs = require('fs'), os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pets-ui-')));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const wa = { x: 0, y: 0, width: 1200, height: 700 };
async function open(file, query, w, h) {
  const win = new BrowserWindow({ width: w, height: h, show: false, webPreferences: { preload: path.join(__dirname, 'ui-preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  const errors = []; win.webContents.on('console-message', (_e, level, message) => { if (level === 3) errors.push(message); });
  await win.loadFile(path.join(__dirname, '..', file), { query }); await sleep(400);
  return { win, errors, js: (code) => win.webContents.executeJavaScript(code) };
}
app.whenReady().then(async () => {
  try {
    // 1) 세션펫 창
    const meta = { id: 'codex:22222222-2222-2222-2222-222222222222', provider: 'codex', transport: 'desktop', pid: null, cwd: '/tmp/shared-project', tty: null, name: 'codex demo', sessionId: '2222' };
    const p = await open('pet-window.html', { id: meta.id }, 280, 200);
    await p.js(`window.smoke.fire(${JSON.stringify({ type: 'init', meta, wa, settings: { haloOn: true }, state: 'working', task: '테스트 작업', taskKind: 'tool' })})`); await sleep(300);
    const s1 = await p.js(`({ has: !!document.querySelector('.spet'), work: document.querySelector('.spet').classList.contains('anim-work'), bubble: document.querySelector('.sbubble').textContent, badge: getComputedStyle(document.querySelector('.desktop-badge')).display !== 'none', ready: window.smoke.sent().some(s => s[0] === 'ready'), moved: window.smoke.sent().some(s => s[0] === 'move') })`);
    if (!s1.has || !s1.work || !/테스트 작업/.test(s1.bubble) || !s1.badge || !s1.ready || !s1.moved) throw Error('pet init failed ' + JSON.stringify(s1));
    await p.js(`window.smoke.fire({ type: 'waiting' })`); await sleep(50);
    const s2 = await p.js(`({ wait: document.querySelector('.spet').classList.contains('anim-wait'), alert: document.querySelector('.spet').classList.contains('alerting'), sentAlert: window.smoke.sent().some(s => s[0] === 'alert' && s[2] && s[2].kind === 'wait') })`);
    if (!s2.wait || !s2.alert || !s2.sentAlert) throw Error('waiting failed ' + JSON.stringify(s2));
    await p.js(`window.smoke.fire({ type: 'working', task: 't2' }); window.smoke.fire({ type: 'done' })`); await sleep(50);
    const s3 = await p.js(`({ done: document.querySelector('.spet').classList.contains('anim-done'), bubble: document.querySelector('.sbubble').textContent, cleared: window.smoke.sent().some(s => s[0] === 'alert' && s[2] === null) })`);
    if (!s3.done || !/완료/.test(s3.bubble) || !s3.cleared) throw Error('done failed ' + JSON.stringify(s3));
    const s4 = await p.js(`(() => { const sp = document.querySelector('.spet'); sp.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, screenX: 10, screenY: 10 })); const m = window.smoke.sent().filter(s => s[0] === 'menu').pop(); return { items: m ? m[2].map(i => i.id).filter(Boolean) : [] }; })()`);
    if (!s4.items.includes('form-mode') || !s4.items.includes('hide-desktop') || !s4.items.includes('flip')) throw Error('menu failed ' + JSON.stringify(s4));
    await p.js(`window.smoke.fire({ type: 'farewell' })`); await sleep(50);
    const s5 = await p.js(`document.querySelector('.sbubble').textContent`); if (!/안녕/.test(s5)) throw Error('farewell failed ' + s5);
    if (p.errors.length) throw Error('pet console errors: ' + p.errors.join(' | '));
    // 2) 메인펫 창
    const m = await open('main-pet.html', {}, 360, 258);
    await m.js(`window.smoke.fire(${JSON.stringify({ type: 'init', wa })})`); await sleep(700);
    const m1 = await m.js(`({ dot: !document.getElementById('dot-sprite').hidden, hp: document.getElementById('hp-session-pct').textContent, moved: window.smoke.sent().some(s => s[0] === 'move' && s[1] === 'main'), resized: window.smoke.sent().some(s => s[0] === 'resize') })`);
    if (!m1.dot || m1.hp !== '42%' || !m1.moved || !m1.resized) throw Error('main pet failed ' + JSON.stringify(m1));
    if (m.errors.length) throw Error('main console errors: ' + m.errors.join(' | '));
    // 3) 패널
    const pn = await open('panel.html', {}, 460, 520);
    await pn.js(`document.querySelector('[data-tab="procs"]').click()`); await sleep(400);
    const pn1 = await pn.js(`({ rows: document.querySelectorAll('.proc').length, count: document.getElementById('proc-count').textContent, badgeBtn: [...document.querySelectorAll('.proc button')].some(b => b.textContent === '펫 숨기기') })`);
    if (pn1.rows !== 3 || pn1.count !== '(3)' || !pn1.badgeBtn) throw Error('panel procs failed ' + JSON.stringify(pn1));
    await pn.js(`providerSelect.value = 'codex'; providerSelect.dispatchEvent(new Event('change')); document.querySelector('[data-tab="usage"]').click()`); await sleep(400);
    const pn2 = await pn.js(`({ gauges: document.querySelectorAll('.ugauge').length, caption: document.getElementById('usage-caption').textContent })`);
    if (pn2.gauges < 1 || !/Codex/.test(pn2.caption)) throw Error('panel usage failed ' + JSON.stringify(pn2));
    if (pn.errors.length) throw Error('panel console errors: ' + pn.errors.join(' | '));
    console.log('UI_PASS', JSON.stringify({ s1, s2, s3, s4, m1, pn1, pn2 }));
    app.exit(0);
  } catch (e) { console.error('UI_FAIL', e.message); app.exit(1); }
});
