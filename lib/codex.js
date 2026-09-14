'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { DesktopIPC } = require('./codex-ipc');
const HOME = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function resolveBin() {
  return [process.env.SESSION_PETS_CODEX_BIN, '/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex', path.join(os.homedir(), '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'].find(p => p && fs.existsSync(p)) || 'codex';
}
function command(bin, args, options = {}) {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout: 10000, maxBuffer: 8 * 1024 * 1024, ...options }, (err, out) => err ? reject(err) : resolve(out)));
}
function commandLabel(value) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  if (text.includes('\n') || text.length > 240) {
    if (/\bpython[0-9.]*\b/.test(text)) return 'Python 스크립트 실행 중';
    if (/\bnode\b/.test(text)) return 'JavaScript 실행 중';
    return '명령 실행 중';
  }
  return text || '명령 실행 중';
}
function label(name, input = {}) {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { patch: input }; } }
  if (/apply_patch|^(Edit|Write)$/.test(name)) {
    const file = input.file_path || /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(input.patch || input.input || '')?.[1];
    return file ? path.basename(file) + ' 수정 중' : '파일 수정 중';
  }
  if (/Bash|exec_command|shell/.test(name)) return input.description || commandLabel(input.cmd || input.command);
  if (/request_user_input/.test(name)) return '사용자 답변 대기';
  if (/update_plan/.test(name)) return input.plan?.find(p => p.status === 'in_progress')?.step || '작업 계획 중';
  if (/search|browse/i.test(name)) return '자료 검색 중';
  if (/spawn_agent|Agent/.test(name)) return input.description || '에이전트 실행 중';
  if (/^mcp__|^write_stdin$|^functions$/.test(name)) return null;
  return name ? name + ' 실행 중' : null;
}
function readSlice(file, tail = false) {
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size, len = Math.min(size, tail ? 256 * 1024 : 128 * 1024), b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, tail ? size - len : 0); return b.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
function parseRollout(text, previous = {}) {
  const out = { ...previous };
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload || {};
    if (row.type === 'session_meta') Object.assign(out, { id: p.id, cwd: p.cwd, source: p.source, parent: p.source?.subAgent, fileSessionId: p.session_id });
    if (row.type === 'event_msg') {
      if (p.type === 'item_completed') {
        const item = p.item || {};
        if (item.type === 'CommandExecution') { out.task = commandLabel(item.command); out.taskKind = 'tool'; }
        if (item.type === 'AgentMessage' && item.phase === 'commentary') {
          out.task = (item.content || []).map(c => typeof c === 'string' ? c : c.text || '').join(' '); out.taskKind = 'tool';
        }
      }
      if (p.type === 'task_started') { out.state = 'working'; out.turnId = p.turn_id; out.completed = false; }
      if (p.type === 'task_complete') { out.state = 'idle'; out.completed = true; }
      if (p.type === 'turn_aborted') { out.state = 'idle'; out.completed = false; }
      if (p.type === 'user_message') { out.state = 'working'; out.task = p.message; out.taskKind = 'prompt'; }
    }
    if (row.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const task = label(p.name || '', p.arguments || p.input || {});
      if (task) { out.task = task; out.taskKind = 'tool'; }
    }
  }
  return out;
}
class RpcClient {
  constructor(bin, args) { this.bin = bin; this.args = args; this.pending = new Map(); this.seq = 0; }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const child = this.child = spawn(this.bin, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
      let buffer = '';
      child.stderr.on('data', () => {});
      child.stdout.on('data', d => {
        buffer += d; let at;
        while ((at = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.method) {
            if (m.id !== undefined) child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Observer does not handle this request' } }) + '\n');
            continue;
          }
          const pending = this.pending.get(m.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(m.id); m.error ? pending.reject(Error(m.error.message)) : pending.resolve(m.result); }
        }
      });
      const fail = () => { if (this.child !== child) return; this.ready = null; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex 서버 연결이 끊겼어요')); } this.pending.clear(); };
      child.on('error', fail); child.on('exit', fail);
      child.stdin.on('error', () => {});
      await this.call('initialize', { clientInfo: { name: 'session-pets', version: '1.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    })().catch(err => { this.close(); throw err; });
    return this.ready;
  }
  call(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Codex 서버 응답 시간 초과')); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  close() { this.child?.kill(); this.child = null; this.ready = null; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex connection closed')); } this.pending.clear(); }
}
class CodexProvider {
  constructor() {
    this.home = HOME(); this.bin = resolveBin(); this.desktop = new DesktopIPC(this.home); this.files = new Map(); this.lastScan = 0;
    this.quiet = new Set(); this.rows = []; this.connections = new Map(); this.scanAt = 0; this.usageRpc = null;
  }
  scan() {
    if (Date.now() - this.lastScan < 10000) return;
    this.lastScan = Date.now();
    const visit = dir => { let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) { const file = path.join(dir, e.name); if (e.isDirectory()) visit(file); else if (/\.jsonl$/.test(e.name)) {
        try { const stat = fs.statSync(file); const prev = this.files.get(file); if (prev?.mtime === stat.mtimeMs) continue;
          const meta = prev || parseRollout(readSlice(file));
          if (!UUID.test(meta.id || '') || meta.parent) continue;
          this.files.set(file, { ...meta, ...parseRollout(readSlice(file, true), meta), file, mtime: stat.mtimeMs });
        } catch {}
      } }
    };
    visit(path.join(this.home, 'sessions'));
  }
  async list() {
    if (this.inflight) return this.inflight;
    this.inflight = this.compute().finally(() => { this.inflight = null; }); return this.inflight;
  }
  async compute() {
    this.scan();
    try { await this.desktop.connect(); for (const meta of this.files.values()) this.desktop.follow(meta.id); } catch {}
    const rows = new Map();
    for (const [file, meta] of this.files) {
      if (!this.desktop.states.has(meta.id) && !this.rows.some(r => r.sessionId === meta.id)) continue;
      try { const mtime = fs.statSync(file).mtimeMs; if (mtime !== meta.mtime) this.files.set(file, { ...parseRollout(readSlice(file, true), meta), mtime }); } catch {}
    }
    for (const [id, entry] of this.desktop.states) {
      const s = entry.state; if (s.sideConversation || s.source?.subAgent || s.threadRuntimeStatus?.type === 'notLoaded') continue;
      const meta = [...this.files.values()].find(x => x.id === id);
      const status = s.threadRuntimeStatus;
      const state = status?.type === 'active' ? ((status.activeFlags?.length || s.requests?.length) ? 'waiting' : 'working') : 'idle';
      rows.set(id, this.row(id, s.cwd, s.title || s.generatedTitle, state, meta, 'desktop', { runtimeError: status?.type === 'systemError' }));
    }
    const socket = path.join(this.home, 'app-server-control/app-server-control.sock');
    if (fs.existsSync(socket)) {
      try {
        if (!this.daemon) this.daemon = new RpcClient(this.bin, ['app-server', 'proxy']);
        await this.daemon.connect(); let cursor;
        do {
          const page = await this.daemon.call('thread/loaded/list', { limit: 100, cursor });
          const results = await Promise.allSettled(page.data.map(id => this.daemon.call('thread/read', { threadId: id, includeTurns: false })));
          for (const r of results) if (r.status === 'fulfilled') { const s = r.value.thread; if (s.parentThreadId || s.source?.subAgent || rows.has(s.id)) continue;
            const meta = [...this.files.values()].find(x => x.id === s.id);
            rows.set(s.id, this.row(s.id, s.cwd, s.name, s.status.type === 'active' ? (s.status.activeFlags.length ? 'waiting' : 'working') : 'idle', meta, 'daemon'));
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch { for (const r of this.rows) if (r.transport === 'daemon') rows.set(r.sessionId, { ...r, disconnected: true }); }
    }
    // Standalone CLI embeds its server: its open rollout is an exact PID -> thread mapping.
    // Never assign sessions by cwd/mtime; multiple terminals can share the same directory.
    try {
      const processes = await command('ps', ['-axo', 'pid=,tty=,comm=']);
      const cli = new Map();
      for (const line of processes.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
        if (m && path.basename(m[3].trim()) === 'codex' && m[2] !== '??') cli.set(Number(m[1]), m[2]);
      }
      if (cli.size) {
        const opened = await command('lsof', ['-a', '-p', [...cli.keys()].join(','), '-Fn']);
        let pid;
        for (const line of opened.split('\n')) {
          if (line.startsWith('p')) pid = Number(line.slice(1));
          else if (line.startsWith('n') && cli.has(pid)) {
            const file = line.slice(1);
            if (!file.startsWith(path.join(this.home, 'sessions') + path.sep) || !file.endsWith('.jsonl')) continue;
            try {
              const meta = parseRollout(readSlice(file, true), this.files.get(file) || parseRollout(readSlice(file)));
              if (!UUID.test(meta.id || '') || meta.parent || rows.has(meta.id)) continue;
              this.files.set(file, { ...meta, file, mtime: fs.statSync(file).mtimeMs });
              const row = this.row(meta.id, meta.cwd, null, meta.state || 'idle', meta, 'cli', { pid, tty: cli.get(pid) });
              let hook; try { hook = JSON.parse(fs.readFileSync(path.join(this.home, 'session-pets-status', meta.id + '.json'))); } catch {}
              if (hook && hook.ts * 1000 >= fs.statSync(file).mtimeMs - 1000) row.state = hook.state;
              row.runtimeError = hook?.event === 'Interrupt' || (meta.state === 'idle' && meta.completed === false);
              rows.set(meta.id, row);
            } catch {}
          }
        }
      }
    } catch {
      for (const r of this.rows) if (r.transport === 'cli') rows.set(r.sessionId, { ...r, disconnected: true });
    }
    // A desktop disconnect is transient, not proof that every thread has ended.
    if ((!this.desktop.clientId && Date.now() - this.desktop.disconnectedAt < 15000) || (this.desktop.clientId && Date.now() - this.desktop.connectedAt < 2000)) {
      for (const r of this.rows) if (r.transport === 'desktop' && !rows.has(r.sessionId)) rows.set(r.sessionId, { ...r, disconnected: true });
    }
    this.rows = [...rows.values()]; return this.rows;
  }
  row(id, cwd, name, state, meta, transport, extras = {}) {
    let hook = null;
    try { hook = JSON.parse(fs.readFileSync(path.join(this.home, 'session-pets-status', id + '.json'), 'utf8')); } catch {}
    const fresh = hook && Date.now() / 1000 - hook.ts < 1800;
    return { id: 'codex:' + id, provider: 'codex', sessionId: id, sessionName: name || path.basename(cwd || '') || 'Codex', cwd, pid: null, tty: null, cpu: 0, cpusec: 0, etime: '', transport,
      state, turnId: meta?.turnId || null, task: fresh ? hook.task : meta?.task, taskKind: fresh ? hook.taskKind : meta?.taskKind, chat: this.quiet.has(id), ...extras };
  }
  async send(id, text) {
    if (typeof text !== 'string' || !text.trim()) throw Error('보낼 메시지가 없어요');
    if (!UUID.test(id || '')) throw Error('정확한 Codex 세션 ID가 필요해요');
    if (this.desktop.states.has(id)) return this.desktop.send(id, text);
    const row = this.rows.find(r => r.sessionId === id);
    if (!['daemon', 'cli'].includes(row?.transport) || row.disconnected) throw Error('살아있는 Codex 세션에 연결할 수 없어요');
    await command(this.bin, ['queue', '--thread', id, '--message', text], { timeout: 15000 }); return { ok: true, mode: 'queue' };
  }
  async interrupt(id) {
    await this.list();
    const cli = this.rows.find(r => r.sessionId === id && r.transport === 'cli' && !r.disconnected);
    if (cli) { process.kill(cli.pid, 'SIGTERM'); return { ok: true }; }
    if (this.desktop.states.has(id)) return this.desktop.interrupt(id);
    if (!this.daemon || !this.rows.some(r => r.sessionId === id && r.transport === 'daemon')) throw Error('연결된 세션이 없어요');
    const r = await this.daemon.call('thread/read', { threadId: id, includeTurns: true });
    const turn = r.thread.turns.findLast(t => t.status === 'inProgress');
    if (turn) await this.daemon.call('turn/interrupt', { threadId: id, turnId: turn.id });
    return { ok: true };
  }
  async usage() {
    if (this.usageCache && Date.now() - this.usageCache.at < 60000) return this.usageCache.value;
    if (this.usagePending) return this.usagePending;
    this.usagePending = (async () => {
      if (!this.usageRpc) this.usageRpc = new RpcClient(this.bin, ['app-server', '--stdio']);
      await this.usageRpc.connect();
      const r = await this.usageRpc.call('account/rateLimits/read');
      const buckets = Object.values(r.rateLimitsByLimitId || { codex: r.rateLimits }).filter(Boolean);
      const windows = buckets.flatMap(b => ['primary', 'secondary'].filter(k => b[k]).map(k => ({ name: [b.limitName || b.limitId || 'Codex', Math.round(b[k].windowDurationMins / 60) + '시간'].join(' · '), pct: b[k].usedPercent, resets: new Date(b[k].resetsAt * 1000).toLocaleString('ko-KR'), minutes: b[k].windowDurationMins })));
      const value = { session: windows[0] || null, weekAll: windows[1] || null, weeks: [], spans: [], windows };
      this.usageCache = { at: Date.now(), value }; return value;
    })().finally(() => { this.usagePending = null; }); return this.usagePending;
  }
  run({ prompt, cwd, sessionId, chat, onOutput, onDone }) {
    if (sessionId && !UUID.test(sessionId)) throw Error('잘못된 세션 ID');
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...(sessionId ? ['resume', sessionId] : []), '-'];
    const child = spawn(this.bin, args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', reply = '', sid = sessionId, finished = false, failure = null;
    const finish = (code, error) => { if (finished) return; finished = true; onDone({ code: failure ? -1 : code, error: error || failure, reply, sessionId: sid }); };
    child.stdin.on('error', () => {}); child.stdin.end(chat ? '너는 귀여운 데스크톱 펫입니다. 도구 없이 1~3문장 존댓말로 답해주세요.\n' + prompt : prompt);
    const consume = line => { let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === 'thread.started') { sid = e.thread_id; this.quiet.add(sid); }
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') { reply = e.item.text; onOutput(reply + '\n'); }
      if (e.type === 'turn.failed' || e.type === 'error') { failure = e.error?.message || e.message || '실행 실패'; onOutput(failure, true); }
    };
    child.stdout.on('data', d => { buffer += d; let at; while ((at = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, at)); buffer = buffer.slice(at + 1); } });
    child.stderr.on('data', d => onOutput(d.toString(), true));
    child.on('error', e => finish(-1, e.message));
    child.on('close', code => { if (buffer.trim()) consume(buffer); finish(code); });
    return child;
  }
  close() { this.desktop.close(); this.daemon?.close(); this.usageRpc?.close(); }
}
module.exports = { CodexProvider, RpcClient, parseRollout, label, commandLabel, resolveBin, HOME };
