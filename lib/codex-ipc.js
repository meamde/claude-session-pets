'use strict';
// Desktop compatibility transport, verified against Codex 0.153.4.
// This is NOT the public app-server protocol. Refuse unknown stream versions.
const net = require('net');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

function applyPatches(state, patches) {
  for (const patch of patches) {
    const parts = patch.path;
    if (!Array.isArray(parts) || parts.some(p => ['__proto__', 'prototype', 'constructor'].includes(String(p)))) throw Error('Invalid stream patch');
    if (!parts.length) { if (patch.op !== 'replace') throw Error('Invalid root patch'); state = patch.value; continue; }
    let obj = state;
    for (const key of parts.slice(0, -1)) { if (obj == null) throw Error('Missing patch path'); obj = obj[key]; }
    const key = parts.at(-1);
    if (patch.op === 'remove') { if (Array.isArray(obj)) obj.splice(Number(key), 1); else delete obj[key]; }
    else if (patch.op === 'add' && Array.isArray(obj)) obj.splice(Number(key), 0, patch.value);
    else if (patch.op === 'add' || patch.op === 'replace') obj[key] = patch.value;
    else throw Error('Unknown patch operation');
  }
  return state;
}

class DesktopIPC extends EventEmitter {
  constructor(home) { super(); this.file = path.join(home, 'ipc/ipc.sock'); this.states = new Map(); this.pending = new Map(); this.followed = new Set(); this.clientId = null; this.socket = null; this.retryAt = 0; this.connectedAt = 0; this.disconnectedAt = 0; }
  async connect() {
    if (this.clientId) return;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAt || !fs.existsSync(this.file)) throw Error('Codex 데스크톱 앱이 연결되지 않았어요');
    const stat = fs.lstatSync(this.file);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw Error('Invalid Codex IPC owner');
    this.connecting = new Promise((resolve, reject) => {
      const socket = this.socket = net.createConnection(this.file);
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => { reject(Error('Codex IPC connection timeout')); socket.destroy(); }, 4000);
      socket.on('connect', async () => {
        try { const r = await this.request('initialize', { clientType: 'session-pets' }, 0); this.clientId = r.result.clientId; this.connectedAt = Date.now(); clearTimeout(timer); resolve(); }
        catch (err) { reject(err); socket.destroy(); }
      });
      socket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        try {
          while (buffer.length >= 4) {
            const len = buffer.readUInt32LE();
            if (!len || len > 64 * 1024 * 1024) throw Error('Invalid Codex IPC frame');
            if (buffer.length < len + 4) break;
            const message = JSON.parse(buffer.subarray(4, len + 4)); buffer = buffer.subarray(len + 4);
            this.receive(message);
          }
        } catch { socket.destroy(); }
      });
      socket.on('error', err => reject(err));
      socket.on('close', () => {
        clearTimeout(timer); reject(Error('Codex IPC disconnected'));
        this.disconnectedAt = Date.now(); this.socket = null; this.clientId = null; this.followed.clear(); this.states.clear(); this.retryAt = Date.now() + 5000;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('연결이 끊겼어요. 전송 여부를 원래 세션에서 확인해주세요')); }
        this.pending.clear();
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  write(message) {
    if (!this.socket || this.socket.destroyed) throw Error('Codex IPC disconnected');
    const payload = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }
  request(method, params, version = 0, targetClientId) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('응답 시간이 초과됐어요. 원래 세션에서 전송 여부를 확인해주세요')); }, 10000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId || 'initializing-client', method, params, version, targetClientId }); }
      catch (err) { clearTimeout(timer); this.pending.delete(requestId); reject(err); }
    });
  }
  follow(id, force = false) {
    if (!this.clientId || (!force && this.followed.has(id))) return;
    this.followed.add(id);
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId, params: { hostId: 'local', conversationId: id, following: true } });
  }
  receive(m) {
    if (m.type === 'client-discovery-request') { this.write({ type: 'client-discovery-response', requestId: m.requestId, response: { canHandle: false } }); return; }
    if (m.type === 'response') {
      const p = this.pending.get(m.requestId); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.requestId);
      if (m.resultType === 'error') p.reject(Error(m.error)); else p.resolve(m);
      return;
    }
    if (m.method === 'thread-stream-following-status-requested' && m.params?.hostId === 'local' && this.followed.has(m.params.conversationId)) this.follow(m.params.conversationId, true);
    if (m.method === 'client-status-changed' && m.params?.status === 'disconnected') {
      for (const [id, s] of this.states) if (s.owner === m.params.clientId) { this.states.delete(id); this.followed.delete(id); }
    }
    if (m.method !== 'thread-stream-state-changed' || m.params?.hostId !== 'local') return;
    const { conversationId: id, change } = m.params;
    if (m.version !== 11) { this.states.delete(id); return; }
    const prev = this.states.get(id);
    try {
      if (change.type === 'snapshot') this.states.set(id, { state: change.conversationState, revision: change.revision, owner: m.sourceClientId });
      else if (change.type === 'patches' && prev && prev.revision === change.baseRevision) {
        prev.state = applyPatches(prev.state, change.patches); prev.revision = change.revision;
      } else { this.follow(id, true); return; }
      this.emit('state', id, this.states.get(id).state);
    } catch { this.states.delete(id); this.follow(id, true); }
  }
  async send(id, text) {
    await this.connect();
    const entry = this.states.get(id); if (!entry) throw Error('연결된 Codex 세션을 찾지 못했어요');
    const state = entry.state;
    if ((state.requests || []).length || state.threadRuntimeStatus?.activeFlags?.length) throw Error('승인 또는 질문에 먼저 답해주세요. 펫을 더블클릭하면 원래 세션을 열어요');
    const input = [{ type: 'text', text, text_elements: [] }];
    const active = state.threadRuntimeStatus?.type === 'active';
    const method = active ? 'thread-follower-steer-turn' : 'thread-follower-start-turn';
    const params = active ? { conversationId: id, input, clientUserMessageId: randomUUID() }
      : { conversationId: id, turnStart: { request: { threadId: id, input, clientUserMessageId: randomUUID() }, context: { inheritThreadSettings: true } } };
    // Never retry a mutation through another transport: delivery may have succeeded.
    await this.request(method, params, active ? 1 : 2, entry.owner);
    return { ok: true, mode: 'desktop' };
  }
  async interrupt(id) {
    const entry = this.states.get(id); if (!entry) throw Error('연결된 Codex 세션이 없어요');
    await this.request('thread-follower-interrupt-turn', { conversationId: id, mode: 'user-stop' }, 3, entry.owner);
    return { ok: true };
  }
  close() { this.socket?.destroy(); }
}
module.exports = { DesktopIPC, applyPatches };
