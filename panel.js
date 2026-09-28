/* Hoo — 패널 창 렌더러 (잡담·명령·목록·사용량·설정). pet.js의 패널 부분 이식.
 * 펫 상태 판정은 메인(lib/petwins.js)이 하므로 목록 탭은 메인이 실어주는 mode를 그대로 표시한다.
 * 메인펫 말풍선·몸짓은 panelEvent로 메인에 부탁하고, 설정 변경은 localStorage(창 간 공유) + settingsChanged 브로드캐스트. */
const $ = (s) => document.querySelector(s);
let selectedProvider = localStorage.getItem('selectedProvider') === 'codex' ? 'codex' : 'claude';
const providerSelect = $('#provider-select');
providerSelect.value = selectedProvider;
providerSelect.addEventListener('change', () => {
  selectedProvider = providerSelect.value; localStorage.setItem('selectedProvider', selectedProvider);
  chatSessionId = localStorage.getItem('chatSessionId:' + selectedProvider) || (selectedProvider === 'claude' ? localStorage.getItem('chatSessionId') : null);
  chatLog.textContent = ''; refreshUsage(true); window.pet.settingsChanged('selectedProvider');
});
const say = (text, ms) => window.pet.panelEvent({ type: 'say', text, ms });
const notify = (text) => window.pet.panelEvent({ type: 'notify', text });
const petAnim = (name) => window.pet.panelEvent({ type: 'anim', name });

$('#panel-close').addEventListener('click', () => window.pet.hidePanel());
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-body').forEach(b => b.classList.toggle('active', b.dataset.tab === tab.dataset.tab));
    if (tab.dataset.tab === 'procs') refreshProcs();
    if (tab.dataset.tab === 'usage') refreshUsage(true);
  });
});

// ── 툴팁 ──
const tooltipEl = $('#tooltip');
document.addEventListener('mousemove', (e) => {
  const tipEl = e.target.closest && e.target.closest('[data-tip]');
  if (tipEl && tipEl.dataset.tip) {
    tooltipEl.textContent = tipEl.dataset.tip; tooltipEl.classList.add('show');
    const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight; let px = e.clientX + 12, py = e.clientY + 16;
    if (px + w > window.innerWidth - 6) px = window.innerWidth - w - 6; if (py + h > window.innerHeight - 6) py = e.clientY - h - 8;
    tooltipEl.style.left = Math.max(6, px) + 'px'; tooltipEl.style.top = Math.max(6, py) + 'px';
  } else tooltipEl.classList.remove('show');
}, true);

// ── 사용량 탭 ──
function usageColor(pct) { return pct >= 90 ? '#e0453a' : pct >= 75 ? '#f5a623' : pct >= 50 ? '#e6c229' : '#57c060'; }
function gaugeHtml(name, u) {
  if (!u) return '';
  const c = usageColor(u.pct); const wrap = document.createElement('div'); wrap.className = 'ugauge';
  const top = document.createElement('div'); top.className = 'ugauge-top';
  const nm = document.createElement('span'); nm.className = 'ugauge-name'; nm.textContent = name;
  const pc = document.createElement('span'); pc.className = 'ugauge-pct'; pc.style.color = c; pc.textContent = u.pct + '%';
  top.append(nm, pc);
  const track = document.createElement('div'); track.className = 'ugauge-track'; const fill = document.createElement('div'); fill.className = 'ugauge-fill'; fill.style.width = Math.min(100, u.pct) + '%'; fill.style.background = c; track.appendChild(fill);
  const rs = document.createElement('div'); rs.className = 'ugauge-reset'; rs.textContent = 'resets ' + u.resets;
  wrap.append(top, track, rs); return wrap;
}
function renderUsageTab(body, u) {
  body.textContent = '';
  if (!u) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '사용량을 불러오지 못했어요'; body.appendChild(e); return; }
  if (u.windows) { for (const w of u.windows) body.appendChild(gaugeHtml(w.minutes === 10080 ? w.name.replace(/168시간|168h/g, '주간') : w.name, w)); return; }
  const s = gaugeHtml('현재 세션 (5시간)', u.session); if (s) body.appendChild(s);
  for (const w of (u.weeks || [])) { const g = gaugeHtml(/all models/i.test(w.model) ? '이번 주 (전체)' : '이번 주 (' + w.model + ')', w); if (g) body.appendChild(g); }
  for (const sp of (u.spans || [])) { const blk = document.createElement('div'); blk.className = 'ublock'; const h = document.createElement('h4'); h.textContent = sp.span === '24h' ? '최근 24시간' : '최근 7일'; const big = document.createElement('div'); big.className = 'big'; big.textContent = `${sp.requests} 요청 · ${sp.sessions} 세션`; blk.append(h, big); body.appendChild(blk); }
}
let usageSeq = 0;
async function refreshUsage(force) {
  const provider = selectedProvider, seq = ++usageSeq;
  $('#usage-caption').textContent = (provider === 'codex' ? 'Codex' : 'Claude') + ' 구독 사용량';
  let u = null; try { u = await window.pet.getUsage(force, provider); } catch {}
  if (seq !== usageSeq) return;
  renderUsageTab($('#usage-body'), u);
  window.pet.settingsChanged('usage'); // 메인펫 HP바도 갱신
}
$('#refresh-usage').addEventListener('click', () => refreshUsage(true));

// ── 목록 탭 ──
let procs = [], sendRowOpen = false;
function procName(p) { if (p.sessionName) return p.sessionName; if (p.cwd) return p.cwd.split('/').filter(Boolean).pop(); return 'PID ' + p.pid; }
function isDesktopPet(p) { return p.provider === 'codex' && p.transport === 'desktop'; }
async function refreshProcs() {
  try { procs = await window.pet.listSessionsView(); } catch { return; }
  $('#proc-count').textContent = procs.length ? `(${procs.length})` : '';
  renderProcs();
}
function renderProcs() {
  const list = $('#proc-list');
  if (sendRowOpen) return;
  if (!procs.length) { list.innerHTML = '<div class="empty">실행 중인 Claude/Codex 세션이 없습니다 🍃</div>'; return; }
  list.innerHTML = '';
  for (const p of procs) {
    const wrap = document.createElement('div'); wrap.className = 'proc-wrap';
    const div = document.createElement('div'); div.className = 'proc';
    const cwd = p.cwd || '(알 수 없음)'; const short = cwd.replace(/^\/Users\/[^/]+/, '~');
    const mode = p.mode || 'idle'; const label = mode === 'working' ? '작업 중' : mode === 'waiting' ? '입력 필요' : '대기';
    const dot = document.createElement('div'); dot.className = 'dot' + (mode === 'working' ? ' busy' : '') + (mode === 'waiting' ? ' wait' : '');
    const info = document.createElement('div'); info.className = 'p-info';
    const titleEl = document.createElement('div'); titleEl.className = 'p-cwd'; titleEl.dataset.tip = cwd; titleEl.textContent = p.sessionName || short;
    const meta = document.createElement('div'); meta.className = 'p-meta';
    meta.textContent = p.provider === 'codex' ? `Codex · ${p.transport === 'desktop' ? '데스크톱 앱' : p.transport === 'cli' ? 'CLI' : '서버'} · ${(p.sessionId || '').slice(0, 8)} · ${p.disconnected ? '재연결 중' : label}` : `PID ${p.pid} · CPU ${Number(p.cpu || 0).toFixed(1)}% · ${p.etime}${p.tty ? ' · ' + p.tty : ''}${p.kind === 'bg' ? ' · 백그라운드' : ''} · ${label}`;
    info.append(titleEl, meta); div.append(dot, info);
    if (cwd) { const send = document.createElement('button'); send.className = 'btn small'; send.textContent = '메시지'; send.title = '이 세션에 메시지를 보냅니다'; send.addEventListener('click', () => openSendRow(wrap, p, short, cwd)); div.appendChild(send); }
    if (isDesktopPet(p)) { const v = document.createElement('button'); v.className = 'btn small'; v.textContent = p.hidden ? '펫 표시' : '펫 숨기기'; v.addEventListener('click', async () => { await window.pet.setDesktopHidden(p.id, !p.hidden); refreshProcs(); }); div.appendChild(v); }
    const kill = document.createElement('button'); kill.className = 'btn danger small'; kill.textContent = p.provider === 'codex' && p.transport !== 'cli' ? '중단' : '종료';
    kill.addEventListener('click', async () => {
      if (!confirm(p.provider === 'codex' && p.transport !== 'cli' ? `${procName(p)} 작업을 중단할까요?` : `PID ${p.pid} (${short}) 프로세스를 종료할까요?`)) return;
      const r = await window.pet.interruptSession({ provider: p.provider, sessionId: p.sessionId, pid: p.pid }); if (!r.ok) alert('종료 실패: ' + r.error); setTimeout(refreshProcs, 400);
    });
    div.appendChild(kill); wrap.appendChild(div); list.appendChild(wrap);
  }
}
function openSendRow(wrap, p, name, cwd) {
  if (sendRowOpen) return; sendRowOpen = true;
  const row = document.createElement('div'); row.className = 'send-row';
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = `${name} 세션에 보낼 메시지… (Enter 전송, Esc 닫기)`;
  const btn = document.createElement('button'); btn.className = 'btn small'; btn.textContent = '보내기';
  const close = () => { sendRowOpen = false; row.remove(); renderProcs(); };
  const doSend = async () => {
    const text = input.value.trim(); if (!text) return; btn.disabled = true; btn.textContent = '전송 중…';
    const r = await window.pet.sendToSession(cwd, p.sessionId || null, text, p.provider);
    if (r.ok) { notify(`📨 ${r.name || name} — 메시지 전송`); close(); } else { btn.disabled = false; btn.textContent = '보내기'; alert(r.error); }
  };
  btn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) doSend(); else if (e.key === 'Escape') close(); });
  row.append(input, btn); wrap.appendChild(row); input.focus();
}
$('#refresh-procs').addEventListener('click', refreshProcs);
setInterval(() => { if (document.querySelector('.tab-body[data-tab="procs"]').classList.contains('active')) refreshProcs(); }, 1500);

// ── 명령 실행 ──
const sessions = new Map();
async function runPrompt() {
  const prompt = $('#prompt-input').value.trim(); if (!prompt) return;
  const cwd = $('#cwd-input').value.trim() || undefined; const id = crypto.randomUUID();
  const el = document.createElement('div'); el.className = 'session';
  const head = document.createElement('div'); head.className = 's-head';
  const status = document.createElement('span'); status.className = 's-status'; status.textContent = '⏳';
  const promptEl = document.createElement('span'); promptEl.className = 's-prompt'; promptEl.title = prompt; promptEl.textContent = prompt;
  const stopBtn = document.createElement('button'); stopBtn.className = 'btn ghost small'; stopBtn.textContent = '중단'; stopBtn.addEventListener('click', () => window.pet.stopRun(id));
  head.append(status, promptEl, stopBtn); const pre = document.createElement('pre'); el.append(head, pre); $('#sessions').prepend(el);
  sessions.set(id, { el, pre, prompt, done: false }); $('#prompt-input').value = '';
  const r = await (selectedProvider === 'codex' ? window.pet.runCodex : window.pet.runClaude)({ id, prompt, cwd });
  if (!r.ok) { finishSession(id, -1, r.error); return; }
  notify(`🏃 "${taskLabel(prompt)}" — 작업 시작`);
}
function taskLabel(prompt) { const one = prompt.replace(/\s+/g, ' ').trim(); return one.length > 24 ? one.slice(0, 24) + '…' : one; }
function finishSession(id, code, error) {
  const s = sessions.get(id); if (!s) return; s.done = true;
  s.el.querySelector('.s-status').textContent = code === 0 ? '✅' : '❌'; const stopBtn = s.el.querySelector('button'); if (stopBtn) stopBtn.remove();
  if (error) { const span = document.createElement('span'); span.className = 'err'; span.textContent = '\n' + error; s.pre.appendChild(span); }
  notify(code === 0 ? `✅ "${taskLabel(s.prompt)}" — 작업 완료` : `❌ "${taskLabel(s.prompt)}" — 작업 실패`);
}
window.pet.onRunOutput(({ id, chunk, stderr }) => { const s = sessions.get(id); if (!s) return; if (stderr) { const span = document.createElement('span'); span.className = 'err'; span.textContent = chunk; s.pre.appendChild(span); } else s.pre.appendChild(document.createTextNode(chunk)); s.pre.scrollTop = s.pre.scrollHeight; });
window.pet.onRunDone(({ id, code, error }) => finishSession(id, code, error));
$('#run-btn').addEventListener('click', runPrompt);
$('#prompt-input').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runPrompt(); });

// ── 잡담 ──
let chatSessionId = localStorage.getItem('chatSessionId:' + selectedProvider) || (selectedProvider === 'claude' ? localStorage.getItem('chatSessionId') : null);
let chatBusy = false; const chatLog = $('#chat-log'), chatInput = $('#chat-input');
function addMsg(cls, text) { const first = chatLog.querySelector('.empty'); if (first) first.remove(); const div = document.createElement('div'); div.className = 'msg ' + cls; div.textContent = text; chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight; return div; }
async function sendChat() {
  const message = chatInput.value.trim(); if (!message || chatBusy) return;
  chatBusy = true; chatInput.value = ''; addMsg('me', message); const thinking = addMsg('pet thinking', '생각 중… 🐾'); petAnim('work');
  const chatProvider = selectedProvider; providerSelect.disabled = true;
  let r; try { r = await (chatProvider === 'codex' ? window.pet.chatCodex : window.pet.chatClaude)({ message, sessionId: chatSessionId }); } catch (e) { r = { ok: false, error: e.message }; }
  providerSelect.disabled = false; thinking.remove(); chatBusy = false; petAnim('idle');
  if (!r.ok) {
    if (chatSessionId) { chatSessionId = null; localStorage.removeItem('chatSessionId:' + selectedProvider); if (selectedProvider === 'claude') localStorage.removeItem('chatSessionId'); chatInput.value = message; addMsg('pet error', '이전 대화를 못 찾았어요. 다시 한 번 보내주세요!'); }
    else addMsg('pet error', '앗, 오류가 났어요: ' + (r.error || '알 수 없음'));
    return;
  }
  if (r.sessionId) { chatSessionId = r.sessionId; localStorage.setItem('chatSessionId:' + selectedProvider, chatSessionId); }
  addMsg('pet', r.reply); if (r.reply.length <= 80) say(r.reply, 4000);
}
$('#chat-send').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendChat(); });
$('#chat-reset').addEventListener('click', () => { chatSessionId = null; localStorage.removeItem('chatSessionId:' + selectedProvider); if (selectedProvider === 'claude') localStorage.removeItem('chatSessionId'); chatLog.innerHTML = '<div class="empty">새 대화를 시작해요 🐾</div>'; });

// ── 설정 ──
$('#reset-image').addEventListener('click', async () => { try { await window.pet.deleteSavedImage(); } catch {} window.pet.settingsChanged('resetImage'); });
$('#change-image').addEventListener('click', async () => { const url = await window.pet.pickImage(); if (url) say('새 모습 어때요? ✨'); });
const sizeSlider = $('#size-slider'), sizeLabel = $('#size-label'); const size0 = Number(localStorage.getItem('petSize')) || 128;
sizeSlider.value = size0; sizeLabel.textContent = size0 + 'px';
sizeSlider.addEventListener('input', () => { sizeLabel.textContent = sizeSlider.value + 'px'; localStorage.setItem('petSize', sizeSlider.value); window.pet.settingsChanged('petSize'); });
const flipCheck = $('#flip-check'); flipCheck.checked = localStorage.getItem('petFlip') === '1';
flipCheck.addEventListener('change', () => { localStorage.setItem('petFlip', flipCheck.checked ? '1' : '0'); window.pet.settingsChanged('petFlip'); });
const bgCheck = $('#bg-remove'); bgCheck.checked = localStorage.getItem('bgRemove') !== '0';
bgCheck.addEventListener('change', () => { localStorage.setItem('bgRemove', bgCheck.checked ? '1' : '0'); window.pet.settingsChanged('bgRemove'); });
const haloCheck = $('#alert-halo'); haloCheck.checked = localStorage.getItem('alertHalo') !== '0';
haloCheck.addEventListener('change', () => { localStorage.setItem('alertHalo', haloCheck.checked ? '1' : '0'); window.pet.settingsChanged('alertHalo', haloCheck.checked); });
const spotCheck = $('#alert-spotlight'); spotCheck.checked = localStorage.getItem('alertSpotlight') !== '0';
spotCheck.addEventListener('change', () => { localStorage.setItem('alertSpotlight', spotCheck.checked ? '1' : '0'); window.pet.settingsChanged('alertSpotlight', spotCheck.checked); });
$('#quit-btn').addEventListener('click', () => window.pet.quit());
window.pet.getHome().then((home) => { $('#cwd-input').value = home; });
// 메인이 '펫 우클릭으로 provider 전환' 등을 브로드캐스트하면 반영
window.pet.onPetEvent((ev) => { if (ev.type === 'settings' && ev.key === 'selectedProvider') { const v = localStorage.getItem('selectedProvider') === 'codex' ? 'codex' : 'claude'; if (v !== selectedProvider) { providerSelect.value = v; providerSelect.dispatchEvent(new Event('change')); } } if (ev.type === 'shown') { refreshProcs(); const active = document.querySelector('.tab-body.active'); (active?.querySelector('input[type=text], textarea') || $('#chat-input')).focus(); } });
refreshProcs(); refreshUsage(false);
