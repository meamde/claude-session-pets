'use strict';
const fs = require('fs');
const path = require('path');
const { HOME } = require('./codex');
const events = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt'];
const marker = 'session-pets-hook.py';
function installed() {
  try { const j = JSON.parse(fs.readFileSync(path.join(HOME(), 'hooks.json'), 'utf8')); return events.every(e => j.hooks?.[e]?.some(g => g.hooks?.some(h => h.command?.includes(marker)))); } catch { return false; }
}
function install() {
  const dir = HOME(), file = path.join(dir, 'hooks.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const j = raw.trim() ? JSON.parse(raw) : {};
  if (!j || Array.isArray(j) || typeof j !== 'object' || (j.hooks && (typeof j.hooks !== 'object' || Array.isArray(j.hooks)))) throw Error('Codex hooks.json 형식을 확인해주세요');
  j.hooks ||= {};
  const script = path.join(dir, marker).replace(/'/g, "'\\''");
  for (const e of events) {
    const groups = j.hooks[e] || [];
    if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks) || g.hooks.some(h => !h || typeof h !== 'object'))) throw Error('Codex hook 이벤트 형식을 확인해주세요: ' + e);
    // A group can contain unrelated commands alongside an older pets hook.
    j.hooks[e] = groups.flatMap(g => {
      const hooks = g.hooks.filter(h => !(typeof h.command === 'string' && h.command.includes(marker)));
      return hooks.length ? [{ ...g, hooks }] : [];
    });
    j.hooks[e].push({ hooks: [{ type: 'command', command: "python3 '" + script + "'", timeout: 3 }] });
  }
  fs.mkdirSync(dir, { recursive: true });
  if (raw && !fs.existsSync(file + '.session-pets-backup')) fs.writeFileSync(file + '.session-pets-backup', raw);
  const helper = path.join(dir, marker), helperTmp = helper + '.tmp';
  fs.copyFileSync(path.join(__dirname, 'codex-hook.py'), helperTmp); fs.renameSync(helperTmp, helper);
  const tmp = file + '.session-pets-tmp'; fs.writeFileSync(tmp, JSON.stringify(j, null, 2)); fs.renameSync(tmp, file);
}
function toggle(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id || '')) throw Error('잘못된 세션 ID');
  if (!installed()) throw Error('메뉴바에서 Codex 상태 훅을 설치하고 Codex /hooks에서 신뢰해주세요');
  const file = path.join(HOME(), 'session-pets-formmode', id); fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) { fs.unlinkSync(file); return false; }
  fs.writeFileSync(file, 'on'); return true;
}
module.exports = { installed, install, toggle };
