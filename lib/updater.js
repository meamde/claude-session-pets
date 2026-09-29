'use strict';
/* Hoo 자동 업데이트 (앱이 직접 처리)
 * Apple 개발자 인증서 없는 ad-hoc 서명 앱이라 Electron 표준 업데이터(Squirrel)는 못 쓴다. 대신:
 *  1. GitHub 최신 릴리스 확인(앱 시작 때 + 6시간마다, 사용자 결정 2026-09)
 *  2. 새 버전이면 알림(메인펫 말풍선 + 트레이 메뉴) → 사용자가 누르면 설치(자동 설치 아님)
 *  3. zip 내려받기 → ditto로 풀기 → 번들 식별자·버전·서명 확인
 *  4. 앱 종료 뒤 셸 스크립트가 옛 앱을 휴지통으로 옮기고 새 앱을 넣고 다시 실행
 * 서명 요구사항이 번들 식별자 기준이라(build-app.sh) 교체 후에도 손쉬운 사용 권한이 유지된다.
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'meamde/hoo-the-agent-pets';
const BUNDLE_ID = 'com.meamde.hoo';
const CHECK_MS = 6 * 60 * 60 * 1000;

// "v1.0.10" > "v1.0.9" 처럼 숫자 단위 비교. a > b 면 양수
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
// 릴리스 첨부 파일 중 이 맥 아키텍처용 zip (예: Hoo-1.0.2-arm64.zip)
function pickAsset(release, arch) {
  const assets = (release && release.assets) || [];
  return assets.find(a => new RegExp('^Hoo-[\\d.]+-' + arch + '\\.zip$').test(a.name)) || null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Hoo-updater', Accept: 'application/vnd.github+json' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
// 첨부 파일 다운로드는 다른 호스트로 리다이렉트된다 → 따라가며 파일로 저장
function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error('리다이렉트가 너무 많아요')); return; }
    const req = https.get(url, { headers: { 'User-Agent': 'Hoo-updater', Accept: 'application/octet-stream' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); resolve(download(res.headers.location, dest, hops + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const out = fs.createWriteStream(dest); res.pipe(out); out.on('finish', () => out.close(() => resolve(dest))); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));

// 테스트용 옵션: bundlePath(교체 대상 .app), waitPid(끝나길 기다릴 프로세스), relaunch(교체 뒤 다시 켜기), quit(앱 종료 함수)
function createUpdater({ app, onAvailable, log, bundlePath, waitPid, relaunch = true, quit }) {
  let latest = null;      // { version, asset, notes, url }
  let timer = null, installing = false;
  const say = (...a) => { try { (log || console.error)('[update]', ...a); } catch {} };
  // 실행 중인 .app 경로 (…/Hoo.app). 개발 실행(npx electron .)이면 null → 업데이트 안 함
  const appBundle = () => { if (bundlePath) return bundlePath; if (!app.isPackaged) return null; const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//); return m ? m[1] : null; };

  async function check() {
    if (!appBundle()) return null;
    try {
      const rel = await getJson('https://api.github.com/repos/' + REPO + '/releases/latest');
      if (!rel || rel.draft || rel.prerelease) return null;
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const asset = pickAsset(rel, process.arch);
      if (!version || !asset || cmpVersion(version, app.getVersion()) <= 0) return null;
      const fresh = !latest || latest.version !== version;
      latest = { version, asset, url: rel.html_url };
      if (fresh && onAvailable) onAvailable(latest);
      return latest;
    } catch (e) { say('확인 실패', e.message); return null; }
  }

  async function install() {
    if (installing || !latest) return { ok: false, error: installing ? '이미 설치 중이에요' : '새 버전이 없어요' };
    const target = appBundle(); if (!target) return { ok: false, error: '개발 실행 중에는 업데이트하지 않아요' };
    installing = true;
    try {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hoo-update-'));
      const zip = path.join(work, latest.asset.name);
      await download(latest.asset.browser_download_url, zip);
      const unpack = path.join(work, 'app'); fs.mkdirSync(unpack);
      await run('/usr/bin/ditto', ['-x', '-k', zip, unpack]);
      const next = path.join(unpack, 'Hoo.app');
      if (!fs.existsSync(next)) throw new Error('받은 파일에 Hoo.app이 없어요');
      // 받은 앱 확인: 번들 식별자·버전·서명
      const plist = path.join(next, 'Contents', 'Info.plist');
      const bid = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', plist])).trim();
      const ver = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist])).trim();
      if (bid !== BUNDLE_ID) throw new Error('번들 식별자가 달라요: ' + bid);
      if (ver !== latest.version) throw new Error('버전이 릴리스와 달라요: ' + ver);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', next]);
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', next]).catch(() => {});
      // 앱이 완전히 끝난 뒤 교체·재실행하는 스크립트 (옛 앱은 휴지통으로 — 되돌릴 수 있게)
      const script = path.join(work, 'swap.sh');
      const trash = path.join(os.homedir(), '.Trash', 'Hoo-old-' + Date.now() + '.app');
      fs.writeFileSync(script, [
        '#!/bin/bash',
        'PID="$1"; TARGET="$2"; NEXT="$3"; TRASH="$4"; LOG="$5"; RELAUNCH="$6"',
        'for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
        'mv "$TARGET" "$TRASH" >>"$LOG" 2>&1 || { [ "$RELAUNCH" = 1 ] && open "$TARGET"; exit 1; }',
        'if ! mv "$NEXT" "$TARGET" >>"$LOG" 2>&1; then mv "$TRASH" "$TARGET"; fi',
        '[ "$RELAUNCH" = 1 ] && open "$TARGET"',
        'echo done >>"$LOG"',
      ].join('\n'), { mode: 0o755 });
      const child = spawn('/bin/bash', [script, String(waitPid || process.pid), target, next, trash, path.join(work, 'swap.log'), relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
      child.unref();
      say('설치 준비 완료', latest.version, '→ 앱을 종료하고 교체합니다');
      setTimeout(() => (quit || (() => app.quit()))('update-install'), 300);
      return { ok: true, version: latest.version, work, trash };
    } catch (e) { installing = false; say('설치 실패', e.message); return { ok: false, error: e.message }; }
  }

  function start() { check(); timer = setInterval(check, CHECK_MS); }
  function stop() { clearInterval(timer); }
  return { start, stop, check, install, get latest() { return latest; }, get installing() { return installing; } };
}

module.exports = { createUpdater, cmpVersion, pickAsset };
