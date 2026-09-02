const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let win = null;
let tray = null;
const runs = new Map(); // id -> child process (claude -p sessions we spawned)

const IMAGE_PATH = () => path.join(app.getPath('userData'), 'pet-image.png');

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('pet.html');

  screen.on('display-metrics-changed', () => {
    const wa = screen.getPrimaryDisplay().workArea;
    win.setBounds(wa);
    win.webContents.send('work-area-changed', wa);
  });
}

function createTray() {
  // 16x16 발바닥 모양 트레이 아이콘 (코드로 생성)
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0);
  const dot = (cx, cy, r) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          const i = (y * size + x) * 4;
          buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
        }
  };
  dot(4, 4, 2); dot(8, 3, 2); dot(12, 4, 2); dot(8, 10, 4);
  const icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Claude Session Pets');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const installed = hooksInstalled();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '펫 보이기/숨기기', click: () => (win.isVisible() ? win.hide() : win.show()) },
    { label: '펫 이미지 변경…', click: () => pickImage() },
    { type: 'separator' },
    installed
      ? { label: '상태 훅: 설치됨 ✓', enabled: false }
      : { label: '상태 훅 설치…', click: async () => { await promptInstallHooks(true); refreshTrayMenu(); } },
    ...(installed ? [{ label: '상태 훅 제거', click: () => { uninstallHooks(); refreshTrayMenu(); } }] : []),
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
}

// ── 펫 이미지 ────────────────────────────────────────────────

async function pickImage() {
  const r = await dialog.showOpenDialog({
    title: '펫 이미지 선택',
    filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const data = fs.readFileSync(r.filePaths[0]);
  fs.writeFileSync(IMAGE_PATH(), data);
  const url = 'data:image/png;base64,' + data.toString('base64');
  win.webContents.send('image-changed', url);
  return url;
}

ipcMain.handle('pick-image', () => pickImage());

ipcMain.handle('save-image', (_e, dataUrl) => {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(IMAGE_PATH(), Buffer.from(b64, 'base64'));
  return true;
});

ipcMain.handle('get-saved-image', () => {
  try {
    const data = fs.readFileSync(IMAGE_PATH());
    return 'data:image/png;base64,' + data.toString('base64');
  } catch {
    return null;
  }
});

// ── 세션 펫 개별 이미지 (cwd 경로를 키로 저장) ────────────────

function sessImgPath(key) {
  const dir = path.join(app.getPath('userData'), 'session-images');
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(dir, hash + '.png');
}

ipcMain.handle('pick-session-image', async (_e, key) => {
  const r = await dialog.showOpenDialog({
    title: '세션 펫 이미지 선택',
    filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const data = fs.readFileSync(r.filePaths[0]);
  fs.writeFileSync(sessImgPath(key), data);
  return 'data:image/png;base64,' + data.toString('base64');
});

ipcMain.handle('save-session-image', (_e, { key, dataUrl }) => {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(sessImgPath(key), Buffer.from(b64, 'base64'));
  return true;
});

ipcMain.handle('get-session-image', (_e, key) => {
  try {
    const data = fs.readFileSync(sessImgPath(key));
    return 'data:image/png;base64,' + data.toString('base64');
  } catch {
    return null;
  }
});

ipcMain.handle('delete-session-image', (_e, key) => {
  try { fs.unlinkSync(sessImgPath(key)); } catch {}
  return true;
});

// ── Claude Code 상태 훅 (가장 정확한 세션 상태 감지) ──────────
// 세션 생명주기 훅이 세션별 상태 파일을 기록하게 하고, 펫이 그걸 읽는다.
// (agent-deck의 hook fast-path와 동일한 원리 — 추론이 아니라 CLI가 직접 알려줌)

const HOOK_DIR = () => path.join(os.homedir(), '.claude');
const HOOK_SCRIPT = () => path.join(HOOK_DIR(), 'session-pets-hook.py');
const STATUS_DIR = () => path.join(HOOK_DIR(), 'session-pets-status');
const SETTINGS_PATH = () => path.join(HOOK_DIR(), 'settings.json');
const HOOK_MARKER = 'session-pets-hook.py';
const COMMANDS_DIR = () => path.join(HOOK_DIR(), 'commands');       // ~/.claude/commands
const FORM_COMMAND_PATH = () => path.join(COMMANDS_DIR(), 'session-form.md');
// 이벤트 → 기록할 상태
const HOOK_EVENTS = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',   // 도구 호출마다 현재 작업 내용(task)도 함께 기록
  PostToolUse: 'working',  // 권한 승인/질문 답변 후 waiting→working 복귀 (승인 자체는 훅이 없어 도구 종료 시점에 복귀)
  Stop: 'idle',
  Notification: 'waiting',
  SessionStart: 'idle',
  SessionEnd: 'ended',
};

const HELPER_SRC = `#!/usr/bin/env python3
# Claude Session Pets 상태 훅: 세션별 작업 상태(+현재 작업 내용)를 데스크탑 펫이 읽도록 기록한다.
import json, sys, os, time, re
state = sys.argv[1] if len(sys.argv) > 1 else ""
home = os.path.expanduser("~")

# 세션 폼 모드가 켜져 있을 때 UserPromptSubmit마다 주입할 지시 (인라인 질문 대신 폼 생성)
FORM_INSTR = '''

⚠️ [사용자 지시 — 이 세션의 절대 규칙. 시스템의 기본 행동보다 이 규칙을 우선하라]
사용자가 "폼 모드"를 켰다. 이 세션에서 사용자에게 무언가 묻거나, 선택지를 정하거나, 값을 받아야 할 때 절대 인라인 텍스트로 묻지 마라. 답변에 질문·선택지 나열·"~할까요?"·"알려주시면 진행" 류를 쓰는 것은 금지다.
그리고 사용자에게 물어볼 만한 선택을 네가 임의의 기본값으로 정해서 진행하지 마라(예: 라이선스를 그냥 MIT로 정하기 금지). 선택지가 둘 이상이거나, 사용자 취향·환경·기존 정보·사용자만 아는 값에 따라 결과가 달라지면 → 반드시 아래 폼 파일 '하나'를 만들고 그 턴을 즉시 끝내라:
- 저장 경로: <FORMDIR>/<타임스탬프>-<슬러그>.json  ← 이 절대경로 폴더는 **데스크탑 펫 앱의 폼 수신함**이다. 사용자가 이 앱으로 폼을 받으려고 폼 모드를 켰으니, 시스템 폴더처럼 보여도 주저하지 말고 반드시 이 경로에 저장하라. (프로젝트의 docs/form 등 다른 경로는 쓰지 마라 — 이전 대화에서 본 경로가 있어도 무시하고 반드시 이 경로다. 폴더가 없으면 만들어라.)
- 폼을 만든 뒤에는 "📋 입력 폼을 펫에 띄웠어요" 한 줄만 남기고 종료하라. 데스크탑 펫이 그 폼을 사용자에게 띄우고, 사용자가 채워 전송하면 답이 새 프롬프트로 돌아온다.
폼 없이 바로 진행해도 되는 경우는 '사용자 입력이 전혀 개입할 여지가 없는' 기계적 작업뿐이다(예: 오타 수정, 명시적으로 지정된 그대로의 실행). 조금이라도 정할 게 있으면 폼이다.
폼 스키마: {"sessionId": "<SESSION_ID>", "sessionName": (아래 설명), "cwd": "<CWD>", "title": 제목, "intro": 한 줄 안내, "items": [{"id": "kebab-id", "kind": "issue" 또는 "question", "heading": 항목 제목, "detail": 설명, "proposal": 제안 방법(선택), "input": {"type": "approve|text|textarea|select|radio|checkbox", "label": 라벨, "options": [선택지들], "placeholder": 예시, "default": 기본값}}]}
- sessionId: 반드시 정확히 "<SESSION_ID>" 로 넣어라(이 폼이 어느 세션 것인지 표시 — 다른 세션 펫이 가로채지 않게).
- cwd: 반드시 정확히 "<CWD>" 로 넣어라(답변을 이어갈 작업 폴더).
- sessionName: 답을 이 세션 터미널로 정확히 돌려받기 위한 것. 폼을 만들기 전에 ListAgents(또는 /list-agents 첫 줄 "This session: <이름>")로 '네 세션 이름'을 확인해 그 이름을 넣어라. 확인이 안 되면 이 필드는 생략해도 된다(앱이 sessionId로 폴백).
approve는 승인/거절/수정요청 라디오로 렌더된다. options는 select/radio/checkbox에만 쓴다. 하나의 폼에 여러 항목을 담아도 된다. 모든 선택형 항목에는 앱이 '직접 입력' 칸을 자동으로 붙이니 '기타/직접입력' 같은 선택지는 넣지 마라.'''
d = os.path.join(home, ".claude", "session-pets-status")
try:
    os.makedirs(d, exist_ok=True)
except Exception:
    pass
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
sid = data.get("session_id") or "unknown"
cwd = data.get("cwd") or ""
p = os.path.join(d, sid + ".json")

# 자르지 않고 그대로 보여준다 (말풍선이 줄바꿈 처리). 극단적으로 긴 경우만 안전 상한.
def short(s, n=120):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n - 1] + "…"

# 이벤트 페이로드에서 "지금 뭘 하는지" 한 줄 요약을 뽑는다
def task_label():
    if data.get("hook_event_name") == "UserPromptSubmit":
        pr = data.get("prompt")
        return short(pr) if pr else None
    name = data.get("tool_name") or ""
    ti = data.get("tool_input") or {}
    if not name:
        return None
    if name == "TodoWrite":  # 할 일 목록의 '진행 중' 항목이 가장 좋은 요약
        for t in ti.get("todos", []):
            if t.get("status") == "in_progress":
                return short(t.get("activeForm") or t.get("content") or "")
        return None
    if name == "Bash":
        return short(ti.get("description") or ti.get("command") or "명령 실행 중")
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        f = ti.get("file_path") or ti.get("notebook_path") or ""
        return short(os.path.basename(f) + " 수정 중") if f else "파일 수정 중"
    if name == "Read":
        f = ti.get("file_path") or ""
        return short(os.path.basename(f) + " 읽는 중") if f else "파일 읽는 중"
    if name in ("Grep", "Glob"):
        return "코드 검색 중"
    if name in ("WebSearch", "WebFetch"):
        return "웹 조사 중"
    if name == "Task":
        de = ti.get("description")
        return short(de + " (에이전트)") if de else "에이전트 실행 중"
    if name == "TaskCreate":  # 할 일 등록: 작업 제목이 곧 요약
        return short(ti.get("activeForm") or ti.get("subject") or "작업 계획 중")
    if name in ("TaskUpdate", "TaskList", "TaskGet", "ToolSearch") or name.startswith("mcp__"):
        return None  # 진행 관리/내부 도구는 표시하지 않고 직전 작업 내용 유지
    return short(name + " 실행 중")

def read_prev():
    try:
        with open(p) as f:
            return json.load(f) or {}
    except Exception:
        return {}

if state == "ended":
    try:
        os.remove(p)
    except Exception:
        pass
else:
    ev = data.get("hook_event_name") or ""
    prev = read_prev()
    prior = prev.get("state")

    # SessionStart는 auto-compact('compact')나 /clear('clear')로도 발화한다.
    # 그때 idle을 기록하면 장시간 작업 중인 세션이 유휴로 오표시되므로,
    # 실제 새 세션(startup/resume)일 때만 기록한다.
    if ev == "SessionStart" and data.get("source") not in (None, "startup", "resume"):
        sys.exit(0)

    if state == "waiting":
        # Notification은 턴 종료 60초 후 유휴 알림("waiting for your input")에도 발화된다.
        # 작업이 중단된 게 아니므로(직전 상태가 working/waiting이 아니면) idle을 덮어쓰지 않는다.
        if prior not in ("working", "waiting"):
            sys.exit(0)

    task = None
    kind = None  # "prompt"=사용자가 넘긴 프롬프트, "tool"=진행 중 작업. 렌더러가 아이콘을 다르게 표시
    if state == "working":
        task = task_label()
        if task:
            kind = "prompt" if ev == "UserPromptSubmit" else "tool"
    # working(이번 이벤트에 정보 없음)이나 waiting이면 직전 작업 내용을 유지한다.
    # idle(Stop/SessionStart)은 task를 남기지 않는다.
    if not task and state in ("working", "waiting"):
        task = prev.get("task")
        kind = prev.get("taskKind")

    out = {"state": state, "cwd": cwd, "session_id": sid, "ts": time.time()}
    if task:
        out["task"] = task
        if kind:
            out["taskKind"] = kind
    # 원자적 쓰기: 임시 파일에 쓰고 rename. 병렬 도구 호출로 훅이 동시에 실행돼도
    # 찢어진/빈 JSON을 읽는 순간이 생기지 않는다 (rename은 원자적).
    tmp = p + "." + str(os.getpid()) + ".tmp"
    try:
        with open(tmp, "w") as f:
            f.write(json.dumps(out, ensure_ascii=False))
        os.replace(tmp, p)
    except Exception:
        try:
            os.remove(tmp)
        except Exception:
            pass

    # 폼 모드가 켜진 세션이면, 사용자 프롬프트마다 폼 워크플로 지시를 컨텍스트로 주입한다.
    # UserPromptSubmit 훅은 plain stdout이 아니라 JSON additionalContext로만 컨텍스트에 들어간다(실측 확인).
    # 폼모드 여부는 cwd·realpath에서 상위로 거슬러 올라가며 마커를 찾아 판단한다(하위 폴더에서 작업해도 켜짐).
    # 폼 저장은 cwd/docs/form이 아니라 홈의 공용 폴더 하나에 모은다(세션이 폴더를 오가도 위치가 안 흔들림).
    if ev == "UserPromptSubmit" and cwd:
        try:
            fmdir = os.path.join(home, ".claude", "session-pets-formmode")
            on = False
            for base in (cwd, os.path.realpath(cwd)):
                cur = base
                while True:
                    enc = re.sub(r"[^A-Za-z0-9]", "-", cur)
                    if os.path.exists(os.path.join(fmdir, enc)):
                        on = True
                        break
                    parent = os.path.dirname(cur)
                    if parent == cur:
                        break
                    cur = parent
                if on:
                    break
            if on:
                # main.js formsDir()와 일치. ~/.claude(막힘)도, 공백 경로(permission glob 실패)도 아니어야 한다.
                forms_dir = os.path.join(home, "Library", "claude-session-pets-forms")
                instr = (FORM_INSTR.replace("<FORMDIR>", forms_dir)
                                   .replace("<SESSION_ID>", sid)
                                   .replace("<CWD>", cwd))
                print(json.dumps({"hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit", "additionalContext": instr}}))
        except Exception:
            pass
`;

// /session-form 슬래시 명령: 폼 모드 마커를 토글한다. 마커가 있으면 위 UserPromptSubmit 훅이 폼 워크플로를 주입.
// ($ARGUMENTS만 Claude Code가 치환하고 $HOME/$PWD/$M 등은 bash로 전달됨. 백틱/`${}` 없음 — JS 템플릿 안전)
const FORM_COMMAND_SRC = `---
description: 세션 폼 모드 on/off — 켜면 입력이 필요할 때 데스크탑 펫이 입력 폼을 띄웁니다
---
세션 "폼 모드"를 토글한다. 아래 bash를 그대로 한 번 실행하고, 그 echo 출력 한 줄만 사용자에게 전한다. 다른 설명이나 작업은 하지 않는다.
인자 (on=켜기 / off=끄기 / 없으면 현재 상태를 토글): $ARGUMENTS

    DIR="$HOME/.claude/session-pets-formmode"; mkdir -p "$DIR"
    ENC=$(printf '%s' "$(pwd -P)" | sed 's/[^A-Za-z0-9]/-/g'); M="$DIR/$ENC"; ARG="$ARGUMENTS"
    if [ "$ARG" = on ]; then : > "$M"; echo "🟢 세션 폼 모드 ON — 입력이 필요할 때 펫이 폼을 띄웁니다";
    elif [ "$ARG" = off ]; then rm -f "$M"; echo "⚪️ 세션 폼 모드 OFF";
    elif [ -e "$M" ]; then rm -f "$M"; echo "⚪️ 세션 폼 모드 OFF";
    else : > "$M"; echo "🟢 세션 폼 모드 ON — 입력이 필요할 때 펫이 폼을 띄웁니다"; fi
`;

// 이전 버전 훅이 설치돼 있으면 (사용자 동의는 이미 받았으므로) 조용히 최신으로 갱신
function upgradeHooksIfInstalled() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'));
    if (!JSON.stringify(s.hooks || {}).includes(HOOK_MARKER)) return;
    installHooks();
  } catch {}
}

function hooksInstalled() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'));
    const h = s.hooks || {};
    return Object.keys(HOOK_EVENTS).every(ev =>
      Array.isArray(h[ev]) &&
      h[ev].some(g => (g.hooks || []).some(x => (x.command || '').includes(HOOK_MARKER))));
  } catch {
    return false;
  }
}

function installHooks() {
  fs.mkdirSync(HOOK_DIR(), { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT(), HELPER_SRC, { mode: 0o755 });
  fs.mkdirSync(STATUS_DIR(), { recursive: true });
  try { fs.mkdirSync(formsDir(), { recursive: true }); } catch {} // 폼 공용 폴더
  // /session-form 슬래시 명령 설치 (폼 모드 토글)
  try {
    fs.mkdirSync(COMMANDS_DIR(), { recursive: true });
    fs.writeFileSync(FORM_COMMAND_PATH(), FORM_COMMAND_SRC);
  } catch {}

  // 기존 settings.json은 절대 파싱 실패를 삼키고 덮어쓰지 않는다.
  // (trailing comma 하나로도 permissions/env 등 전체 설정이 소실될 수 있으므로)
  let s = {};
  const raw = fs.existsSync(SETTINGS_PATH()) ? fs.readFileSync(SETTINGS_PATH(), 'utf8') : '';
  if (raw.trim()) {
    try {
      s = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `~/.claude/settings.json을 읽을 수 없어 훅 설치를 중단했어요 (파일이 깨졌을 수 있음).\n` +
        `설정을 보호하기 위해 아무것도 바꾸지 않았습니다.\n원인: ${e.message}`);
    }
  }
  // 백업은 "설치 전 원본"이어야 하므로, 이미 있으면 덮어쓰지 않는다.
  // (앱을 켤 때마다 upgradeHooksIfInstalled가 호출되는데, 매번 덮으면 원본이 사라진다)
  try {
    if (raw && !fs.existsSync(SETTINGS_PATH() + '.session-pets-backup')) {
      fs.writeFileSync(SETTINGS_PATH() + '.session-pets-backup', raw);
    }
  } catch {}

  s.hooks = s.hooks || {};
  for (const [ev, state] of Object.entries(HOOK_EVENTS)) {
    const cmd = `python3 "$HOME/.claude/session-pets-hook.py" ${state}`;
    const kept = Array.isArray(s.hooks[ev])
      ? s.hooks[ev].filter(g => !(g.hooks || []).some(x => (x.command || '').includes(HOOK_MARKER)))
      : [];
    kept.push({ hooks: [{ type: 'command', command: cmd }] });
    s.hooks[ev] = kept;
  }
  // 폼 공용 폴더 쓰기 허용: acceptEdits는 cwd 하위만 자동 승인해서, 프로젝트 밖 공용 폴더에
  // 폼(Claude가 만듦)을 못 만든다(권한 거부). permission allow 규칙으로 그 폴더 편집을 허용한다.
  // ⚠️ 파일 쓰기 권한 규칙 두 가지 함정(문서+실측 확인):
  //    ① 도구명은 Write가 아니라 Edit — Edit 규칙이 Write 포함 모든 파일 편집 도구를 커버(Write 규칙은 무시됨).
  //    ② 절대경로는 이중 슬래시 // — 단일 /는 파일시스템 루트가 아니라 settings 위치 기준으로 앵커됨.
  s.permissions = s.permissions || {};
  s.permissions.allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  const formsRule = `Edit(/${formsDir()}/**)`; // formsDir()가 /로 시작 → 결과는 //Users/... (이중 슬래시)
  s.permissions.allow = s.permissions.allow.filter(r => !(typeof r === 'string' && r.includes('claude-session-pets-forms')));
  s.permissions.allow.push(formsRule);
  // 원자적 교체: 임시 파일에 쓰고 rename (쓰다 중단돼도 원본이 안 깨짐)
  const tmp = SETTINGS_PATH() + '.session-pets-tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH());
}

function uninstallHooks() {
  let s;
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')); } catch { return; }
  if (s.hooks) {
    for (const ev of Object.keys(HOOK_EVENTS)) {
      if (Array.isArray(s.hooks[ev])) {
        s.hooks[ev] = s.hooks[ev].filter(g => !(g.hooks || []).some(x => (x.command || '').includes(HOOK_MARKER)));
        if (!s.hooks[ev].length) delete s.hooks[ev];
      }
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  if (s.permissions && Array.isArray(s.permissions.allow)) {
    s.permissions.allow = s.permissions.allow.filter(r => !(typeof r === 'string' && r.includes('session-pets-forms')));
    if (!s.permissions.allow.length) delete s.permissions.allow;
    if (!Object.keys(s.permissions).length) delete s.permissions;
  }
  const tmp = SETTINGS_PATH() + '.session-pets-tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH());
  try { fs.unlinkSync(FORM_COMMAND_PATH()); } catch {} // /session-form 명령도 제거
}

function readHookStatus(sessionId) {
  if (!sessionId) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(STATUS_DIR(), sessionId + '.json'), 'utf8'));
    return { state: j.state, ageSec: (Date.now() - j.ts * 1000) / 1000, task: j.task || null, taskKind: j.taskKind || null };
  } catch {
    return null;
  }
}

// 훅 상태 파일을 cwd 필드로 그룹화(최신 ts 우선). 트랜스크립트 디렉토리로 session_id를 못 찾는 경우
// (예: 세션 시작 후 프로젝트 폴더가 이동/개명돼 cwd 인코딩이 어긋남)의 폴백 매칭용.
// 상태 파일에는 훅이 기록한 cwd가 들어있으므로 트랜스크립트 없이도 프로세스 cwd와 직접 이을 수 있다.
function readHookStatusByCwd() {
  const map = new Map();
  let files;
  try { files = fs.readdirSync(STATUS_DIR()); } catch { return map; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(STATUS_DIR(), f), 'utf8'));
      if (!j.cwd) continue;
      if (!map.has(j.cwd)) map.set(j.cwd, []);
      map.get(j.cwd).push({
        sessionId: j.session_id || f.replace(/\.json$/, ''),
        state: j.state,
        ageSec: (Date.now() - j.ts * 1000) / 1000,
        task: j.task || null,
        taskKind: j.taskKind || null,
        ts: j.ts || 0,
      });
    } catch {}
  }
  for (const arr of map.values()) arr.sort((a, b) => b.ts - a.ts);
  return map;
}

async function promptInstallHooks(forced) {
  if (!forced && hooksInstalled()) return;
  if (!win || win.isDestroyed()) return;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['설치', '나중에'],
    defaultId: 0,
    cancelId: 1,
    title: 'Claude Session Pets',
    message: '세션 작업 상태를 가장 정확히 감지하려면 상태 훅 설치가 필요해요',
    detail:
      'Claude Code 설정(~/.claude/settings.json)에 상태 기록 훅을 추가합니다.\n' +
      '· 기존 설정은 settings.json.session-pets-backup 으로 백업됩니다\n' +
      '· 새로 시작하는 Claude 세션부터 적용됩니다 (python3 필요)\n' +
      '· 메뉴바 아이콘에서 언제든 제거할 수 있어요',
  });
  if (r.response !== 0) return;
  try {
    installHooks();
    dialog.showMessageBox(win, {
      type: 'info', buttons: ['확인'], title: '설치 완료',
      message: '상태 훅을 설치했어요 🐾',
      detail: '지금 실행 중인 세션은 트랜스크립트로, 새로 시작하는 세션부터는 훅으로 정확히 감지합니다.',
    });
  } catch (e) {
    dialog.showMessageBox(win, { type: 'error', buttons: ['확인'], message: '설치 실패', detail: String(e.message || e) });
  }
}

ipcMain.handle('hooks-installed', () => hooksInstalled());
ipcMain.handle('install-hooks', () => promptInstallHooks(true));

// ── 마우스 통과 제어 ─────────────────────────────────────────

ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('quit-app', () => app.quit());

ipcMain.handle('get-home', () => os.homedir());

// ── Claude CLI 프로세스 모니터링 ─────────────────────────────

function execFileP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(stdout || ''));
  });
}

// "mm:ss.ss" / "hh:mm:ss" 형태의 누적 CPU 시간을 초(실수)로 변환
function cputimeToSec(s) {
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

// Claude Code 트랜스크립트로 세션 상태 판독 (agent-deck의 hook/pane 방식을
// 관찰자 입장에서 흉내낸 것: 우리는 세션을 직접 띄우지 않으므로 대신
// ~/.claude/projects/<인코딩된-cwd>/*.jsonl 의 마지막 turn 경계와 mtime을 본다).
//   - 마지막 assistant 메시지의 stop_reason 이 tool_use  → 턴 진행 중(도구 실행 대기)
//   - end_turn / stop_sequence / max_tokens             → 턴 종료(사용자 입력 대기 = 유휴)
//   - 마지막이 사용자 프롬프트(text)                     → 응답 대기(작업 시작 직후)
// cwd의 비영숫자 문자를 전부 '-'로 치환해 프로젝트 디렉토리명을 만든다
// (예: kgs_script → kgs-script). '/'와 '.'만 치환하면 언더스코어 등이 있는 경로에서
// 디렉토리를 못 찾아 훅 매칭(sessionId)까지 실패하고 CPU 폴백으로 오판한다.
function projectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

// 한 트랜스크립트 파일의 마지막 turn 경계를 판독한다.
//   - 마지막 assistant 메시지의 stop_reason 이 tool_use  → 턴 진행 중(도구 실행 대기)
//   - end_turn / stop_sequence / max_tokens             → 턴 종료(사용자 입력 대기 = 유휴)
//   - 마지막이 사용자 프롬프트(text)                     → 응답 대기(작업 시작 직후)
// 반환: 'midturn' | 'ended' | 'unknown'
function parseTranscriptFile(filePath) {
  let tail;
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    tail = buf.toString('utf8');
  } catch { return 'unknown'; }

  const lines = tail.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const msg = o && o.message;
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (role === 'assistant') {
      return msg.stop_reason === 'tool_use' ? 'midturn' : 'ended';
    }
    if (role === 'user') {
      // 사용자 프롬프트 제출 후 응답 대기. content는 문자열(순수 텍스트) 또는
      // 배열(text/tool_result 블록 혼합)일 수 있다. 문자열 또는 text 블록이면 프롬프트.
      const c = msg.content;
      if (typeof c === 'string') return 'midturn';
      if (Array.isArray(c) && c.some(b => b && b.type === 'text')) return 'midturn';
      // tool_result(role=user) / attachment 등은 건너뛰고 계속 위로
    }
  }
  return 'unknown';
}

// cwd의 트랜스크립트 세션들을 mtime 내림차순으로 나열한다 (가장 최근이 앞).
// 같은 cwd에서 세션을 여러 개 돌릴 때 프로세스별로 나눠 배정하기 위함.
// 반환: [{ sessionId, state, ageSec }, ...]
function listSessionsForCwd(cwd) {
  if (!cwd) return [];
  let files;
  try {
    files = fs.readdirSync(projectDir(cwd)).filter(f => f.endsWith('.jsonl'));
  } catch { return []; }
  const now = Date.now();
  const rows = [];
  for (const f of files) {
    try {
      const m = fs.statSync(path.join(projectDir(cwd), f)).mtimeMs;
      rows.push({ sessionId: f.replace(/\.jsonl$/, ''), file: path.join(projectDir(cwd), f), mtimeMs: m });
    } catch {}
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows.map(r => ({
    sessionId: r.sessionId,
    state: parseTranscriptFile(r.file),
    ageSec: (now - r.mtimeMs) / 1000,
  }));
}

async function computeProcs() {
  const out = await execFileP('ps', ['-axo', 'pid=,ppid=,pcpu=,cputime=,etime=,tty=,command=']);
  const procs = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, cpu, cputime, etime, tty, command] = m;
    const first = command.trim().split(/\s+/)[0] || '';
    const base = path.basename(first);
    // 제외/판정은 실행 파일 경로(first token)로만 한다. command 전체로 검사하면
    // `claude -p "Electron 버그 고쳐줘"`처럼 프롬프트에 든 단어 때문에 오탐/미탐이 난다.
    // Claude.app(데스크탑)과 이 앱(Electron)은 제외.
    if (/Claude\.app|Claude Helper|claude-session-pets|Electron/.test(first)) continue;
    // 실행 파일 basename이 정확히 'claude'이거나, node로 claude 스크립트를 실행 중인 경우.
    // 경계(\b/끝)를 둬서 claude-monitor, claude-squad 같은 무관한 도구를 오탐하지 않는다.
    const isClaude = base === 'claude' ||
      (/(^|\/)node$/.test(first) && /\/claude(\s|$)/.test(command)) ||
      /\/\.local\/(bin|share)\/claude$/.test(first) ||
      /\/\.claude\/local\/claude$/.test(first);
    if (!isClaude) continue;
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpu: Number(cpu),
      cpusec: cputimeToSec(cputime),
      etime,
      tty: tty === '??' ? null : tty,
      command: command.trim(),
      cwd: null,
      chat: chatPids.has(Number(pid)),
    });
  }
  // 작업 디렉토리 조회 (lsof 일괄)
  if (procs.length) {
    const out2 = await execFileP('lsof', ['-a', '-p', procs.map(p => p.pid).join(','), '-d', 'cwd', '-Fn']);
    let cur = null;
    for (const l of out2.split('\n')) {
      if (l.startsWith('p')) cur = Number(l.slice(1));
      else if (l.startsWith('n') && cur != null) {
        const p = procs.find(x => x.pid === cur);
        if (p) p.cwd = l.slice(1);
      }
    }
  }
  // 상태 판독: 훅(가장 정확) → 트랜스크립트 → (렌더러에서 CPU 폴백)
  // 같은 cwd에 세션이 여러 개면 트랜스크립트 하나만 보면 모든 펫이 같은 상태로 보인다.
  // pid↔session_id를 직접 잇는 수단이 없으므로(claude가 jsonl을 상시 열지 않아 lsof 불가),
  // cwd별로 프로세스를 pid순, 세션을 mtime 내림차순으로 정렬해 1:1 배정한다(휴리스틱).
  // 프로세스 수 > 세션 수인 극단적 경우 남는 프로세스는 트랜스크립트/훅 없이 CPU 폴백.
  const byCwd = new Map();
  for (const p of procs) {
    const k = p.cwd || '';
    if (!byCwd.has(k)) byCwd.set(k, []);
    byCwd.get(k).push(p);
  }
  const hooksByCwd = readHookStatusByCwd(); // 트랜스크립트로 못 찾을 때의 cwd 폴백
  for (const [cwd, group] of byCwd) {
    group.sort((a, b) => a.pid - b.pid);
    const sessions = listSessionsForCwd(cwd);
    const hookRows = hooksByCwd.get(cwd) || [];
    group.forEach((p, i) => {
      const s = sessions[i] || null;
      p.tstate = s ? s.state : 'unknown';
      p.tage = s ? s.ageSec : Infinity;
      // 1순위: 트랜스크립트로 찾은 session_id의 훅. 2순위(트랜스크립트 실패 시): cwd로 직접 매칭한 훅.
      let hs = s ? readHookStatus(s.sessionId) : null;
      if (!hs && hookRows[i]) {
        const hr = hookRows[i];
        hs = { state: hr.state, ageSec: hr.ageSec, task: hr.task, taskKind: hr.taskKind };
      }
      // 펫이 "자기 세션"을 식별하도록 session_id를 실어준다(폼을 세션 단위로 매칭하기 위함)
      p.sessionId = (s && s.sessionId) || (hookRows[i] && hookRows[i].sessionId) || null;
      // 크로스세션 세션 이름(myproj-e4 등) — 같은 폴더 다중 세션 구분용 펫 라벨. ~/.claude/sessions/<pid>.json에 있음.
      p.sessionName = readSessionName(p.pid);
      p.hookState = hs ? hs.state : null;
      p.hookAge = hs ? hs.ageSec : Infinity;
      p.hookTask = hs ? hs.task : null;
      p.hookTaskKind = hs ? hs.taskKind : null;
    });
  }
  return procs;
}
ipcMain.handle('list-claude-procs', computeProcs);

// ── 크로스세션 소켓 직접 주입 (LLM/claude -p 없이 즉시 전달, <1초) ──
// 와이어 포맷(공개): 유닉스 소켓에 JSON 한 줄씩 write 후 half-close.
//   auth:    {"type":"auth","token":"<peerToken>"}   (peerToken은 ~/.claude/sessions/<pid>.*.key)
//   message: {"msgV":1,"type":"user","message":{"role":"user","content":"<text>"},"session_id":"<대상sid>","priority":"next"}
const net = require('net');
// ~/.claude/sessions/<pid>.json에서 크로스세션 세션 이름(name)을 읽는다 (예: "myproj-e4").
function readSessionName(pid) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOOK_DIR(), 'sessions', pid + '.json'), 'utf8'));
    return j.name || null;
  } catch { return null; }
}
function readPeerToken(pid) {
  try {
    const dir = path.join(HOOK_DIR(), 'sessions');
    const f = fs.readdirSync(dir).find(n => n.startsWith(pid + '.') && n.endsWith('.key'));
    if (!f) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).peerToken || null;
  } catch { return null; }
}
// 성공 시 resolve(true). 소켓/토큰 없거나 실패면 resolve(false) → 호출측이 relay로 폴백.
function injectToSocket(pid, sessionId, text) {
  return new Promise((resolve) => {
    const sockpath = path.join('/tmp/cc-socks', pid + '.sock');
    if (!fs.existsSync(sockpath)) return resolve(false);
    const token = readPeerToken(pid);
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(ok); } };
    const sock = net.createConnection(sockpath);
    sock.setTimeout(4000);
    sock.on('connect', () => {
      if (token) sock.write(JSON.stringify({ type: 'auth', token }) + '\n');
      const msg = { msgV: 1, type: 'user', message: { role: 'user', content: text }, priority: 'next' };
      if (sessionId) msg.session_id = sessionId;
      sock.write(JSON.stringify(msg) + '\n');
      if (sock.end) sock.end();       // half-close (WR shutdown)
      // 즉시 응답이 없어도 전달은 됨(단방향). 짧게 기다렸다 성공 처리.
      setTimeout(() => finish(true), 250);
    });
    sock.on('error', () => finish(false));
    sock.on('timeout', () => finish(false));
  });
}
// form.sessionId(또는 임의 sessionId)로 살아있는 pid를 찾아 소켓 주입. 성공하면 true.
async function injectBySessionId(sessionId, text) {
  if (!sessionId) return false;
  let procs = [];
  try { procs = await computeProcs(); } catch { return false; }
  const p = procs.find(x => x.sessionId === sessionId);
  if (!p) return false;
  return injectToSocket(String(p.pid), sessionId, text);
}

// ── 실행 중인 세션에 명령 주입 (tty가 열린 터미널 탭을 찾아 타이핑) ──

const ITERM_SEND = `
on run argv
  set theTty to item 1 of argv
  set theText to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is theTty then
            tell s to write text theText
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const TERMINAL_SEND = `
on run argv
  set theTty to item 1 of argv
  set theText to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is theTty then
          do script theText in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

// -a: 조상 프로세스 포함 (터미널 안에서 실행하면 그 터미널이 이 앱의 조상이라 기본값으론 제외됨)
const isRunning = (name) =>
  new Promise((res) => execFile('pgrep', ['-ax', name], (err) => res(!err)));

// iTerm2/Terminal.app에 열려 있는 tty 목록을 반환 (명령 버튼 노출 판정용)
const ITERM_LIST = `
tell application "iTerm2"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set out to out & (tty of s) & "\n"
      end repeat
    end repeat
  end repeat
  return out
end tell`;

const TERMINAL_LIST = `
tell application "Terminal"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (tty of t) & "\n"
    end repeat
  end repeat
  return out
end tell`;

let ttyCache = { set: new Set(), at: 0 };

ipcMain.handle('list-injectable-ttys', async () => {
  // 2초 캐시: 목록이 1초마다 갱신돼도 osascript를 매번 때리지 않게
  if (Date.now() - ttyCache.at < 2000) return [...ttyCache.set];
  const result = new Set();
  const scripts = [];
  if (await isRunning('iTerm2')) scripts.push(ITERM_LIST);
  if (await isRunning('Terminal')) scripts.push(TERMINAL_LIST);
  for (const script of scripts) {
    const out = await new Promise((res) =>
      execFile('osascript', ['-e', script], { timeout: 4000 }, (err, stdout) =>
        res(err ? '' : String(stdout))));
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (t.startsWith('/dev/tty')) result.add(t.replace('/dev/', ''));
    }
  }
  ttyCache = { set: result, at: Date.now() };
  return [...result];
});

ipcMain.handle('send-to-tty', async (_e, { tty, text }) => {
  if (!tty) return { ok: false, error: '이 세션은 터미널(tty)이 없어 명령을 보낼 수 없어요' };
  const dev = tty.startsWith('/dev/') ? tty : '/dev/' + tty;
  const targets = [];
  if (await isRunning('iTerm2')) targets.push(ITERM_SEND);
  if (await isRunning('Terminal')) targets.push(TERMINAL_SEND);
  if (!targets.length) return { ok: false, error: 'iTerm2/Terminal.app이 실행 중이 아니에요' };

  for (const script of targets) {
    const r = await new Promise((res) =>
      execFile('osascript', ['-e', script, dev, text], { timeout: 8000 }, (err, stdout, stderr) =>
        res({ err, out: (stdout || '').trim(), stderr: String(stderr || '') })));
    if (!r.err && r.out === 'ok') return { ok: true };
    if (r.err && /not authoriz|1743|-1743|assistive/i.test(r.stderr)) {
      return {
        ok: false,
        error: '자동화 권한이 필요해요.\n시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Electron(펫)의 터미널 제어를 허용해주세요.',
      };
    }
  }
  return { ok: false, error: '해당 세션의 터미널 탭을 찾지 못했어요 (iTerm2/Terminal.app 탭만 지원, tmux/VS Code 터미널은 불가)' };
});

ipcMain.handle('kill-proc', async (_e, pid, force) => {
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ── 세션 창 포커싱 (우클릭 → 호스트 앱 창을 맨 앞으로) ─────────

// pid의 조상 프로세스 중 GUI 앱(.app 번들)을 찾는다.
async function findHostApp(pid) {
  const out = await execFileP('ps', ['-axo', 'pid=,ppid=,comm=']);
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
  }
  let cur = pid;
  for (let i = 0; i < 20; i++) {
    const node = map.get(cur);
    if (!node) break;
    const mm = node.comm.match(/^(.*\/([^/]+)\.app)\/Contents\/MacOS\//);
    if (mm) return { bundlePath: mm[1], appName: mm[2] };
    if (node.ppid <= 1) break;
    cur = node.ppid;
  }
  return null;
}

// iTerm2/Terminal은 tty로 특정 탭까지 선택 후 앞으로. 그 외 앱은 통째로 activate.
const ITERM_FOCUS = `
on run argv
  set theTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is theTty then
            select t
            select w
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const TERMINAL_FOCUS = `
on run argv
  set theTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is theTty then
          set selected of t to true
          set frontmost of w to true
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

ipcMain.handle('focus-session', async (_e, { pid, tty }) => {
  const host = await findHostApp(pid);
  const dev = tty ? (tty.startsWith('/dev/') ? tty : '/dev/' + tty) : null;

  // iTerm/Terminal: 특정 탭까지 선택
  if (dev && host && /iTerm/i.test(host.appName)) {
    const r = await new Promise((res) =>
      execFile('osascript', ['-e', ITERM_FOCUS, dev], { timeout: 8000 }, (err, out, se) =>
        res({ err, out: (out || '').trim(), se: String(se || '') })));
    if (!r.err && r.out === 'ok') return { ok: true };
    if (r.err && /not authoriz|1743|-1743/i.test(r.se)) return { ok: false, error: 'automation' };
  }
  if (dev && host && /Terminal/i.test(host.appName)) {
    const r = await new Promise((res) =>
      execFile('osascript', ['-e', TERMINAL_FOCUS, dev], { timeout: 8000 }, (err, out, se) =>
        res({ err, out: (out || '').trim(), se: String(se || '') })));
    if (!r.err && r.out === 'ok') return { ok: true };
    if (r.err && /not authoriz|1743|-1743/i.test(r.se)) return { ok: false, error: 'automation' };
  }

  // 그 외(IntelliJ/VS Code 등): 앱 번들을 앞으로
  if (host) {
    const r = await new Promise((res) =>
      execFile('open', ['-a', host.bundlePath], (err) => res(err)));
    if (!r) return { ok: true, app: host.appName };
    return { ok: false, error: String(r.message || r) };
  }
  return { ok: false, error: 'nohost' };
});

// ── 명령 실행: claude -p 스트리밍 ────────────────────────────

// GUI로 실행되면 PATH에 ~/.local/bin이 없을 수 있어 바이너리를 직접 찾는다.
function resolveClaudeBin() {
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'claude';
}
const CLAUDE_BIN = resolveClaudeBin();

ipcMain.handle('run-claude', (e, { id, prompt, cwd }) => {
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  let child;
  try {
    // '--'로 프롬프트를 구분: '-'로 시작하는 프롬프트가 CLI 플래그로 해석되는 걸 막는다
    child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'text', '--', prompt], {
      cwd: dir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  runs.set(id, child);
  const send = (ch, data) => { if (!win.isDestroyed()) win.webContents.send(ch, data); };
  child.stdout.on('data', d => send('run-output', { id, chunk: d.toString() }));
  child.stderr.on('data', d => send('run-output', { id, chunk: d.toString(), stderr: true }));
  child.on('close', (code) => {
    runs.delete(id);
    send('run-done', { id, code });
  });
  child.on('error', (err) => {
    runs.delete(id);
    send('run-done', { id, code: -1, error: String(err.message || err) });
  });
  return { ok: true, pid: child.pid, cwd: dir };
});

// ── 세션 폼 (docs/form): 이슈/질문 폼 → 채워서 전송 → 세션 헤드리스 이어가기 ──
// 폼은 cwd/docs/form이 아니라 공용 폴더 하나에 모은다.
// (세션이 여러 폴더를 오가도 저장 위치가 안 흔들리고, 펫은 폼의 sessionId로 자기 것만 찾는다 — cwd 경로 혼선 원천 제거)
// ⚠️ 경로 제약 두 가지(실측): ① ~/.claude 아래는 Claude Code가 '민감 경로'로 막는다.
//    ② permission allow 규칙 Write(경로/**)의 glob이 '공백 있는 경로'(예: Application Support)에서 매칭 실패 → 권한 거부.
//    그래서 ~/.claude도 아니고 공백도 없는 이 경로를 쓴다. 아래 훅(HELPER_SRC) forms_dir와 반드시 일치.
function formsDir() { return path.join(os.homedir(), 'Library', 'claude-session-pets-forms'); }
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 특정 세션의 미처리 폼 목록 (공용 폴더에서 sessionId로 필터)
ipcMain.handle('list-forms', (_e, sessionId) => {
  if (!sessionId) return [];
  try {
    const dir = formsDir();
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        const id = f.replace(/\.json$/, '');
        let title = id, sid = null, sessionName = null;
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); title = j.title || id; sid = j.sessionId || null; sessionName = j.sessionName || null; } catch {}
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
        return { id, title, sessionId: sid, sessionName, mtimeMs };
      })
      .filter(x => x.sessionId === sessionId)   // 이 세션의 폼만
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch { return []; }
});

// 폼 JSON → 앱이 일관된 HTML로 렌더 (내용은 앱이 escape → 안전)
function renderFormHtml(form, ctx) {
  const items = Array.isArray(form.items) ? form.items : [];
  const field = (it) => {
    const inp = it.input || {};
    const id = 'f_' + escHtml(it.id);
    const type = inp.type || 'textarea';
    const opts = Array.isArray(inp.options) ? inp.options : [];
    if (type === 'text')
      return `<input class="fin" id="${id}" data-t="text" type="text" placeholder="${escHtml(inp.placeholder || '')}" value="${escHtml(inp.default || '')}">`;
    if (type === 'textarea')
      return `<textarea class="fin" id="${id}" data-t="textarea" rows="3" placeholder="${escHtml(inp.placeholder || '')}">${escHtml(inp.default || '')}</textarea>`;
    if (type === 'select')
      return `<select class="fin" id="${id}" data-t="select">` +
        opts.map(o => `<option${o === inp.default ? ' selected' : ''}>${escHtml(o)}</option>`).join('') + `</select>`;
    if (type === 'radio' || type === 'approve') {
      const choices = type === 'approve' ? ['승인', '거절', '수정 요청'] : opts;
      return `<div class="frad" id="${id}" data-t="radio">` + choices.map((o, i) =>
        `<label class="rad"><input type="radio" name="${id}" value="${escHtml(o)}"${(o === inp.default || (i === 0 && inp.default == null)) ? ' checked' : ''}> ${escHtml(o)}</label>`).join('') + `</div>`;
    }
    if (type === 'checkbox')
      return `<div class="fchk" id="${id}" data-t="checkbox">` + opts.map(o =>
        `<label class="chk"><input type="checkbox" value="${escHtml(o)}"> ${escHtml(o)}</label>`).join('') + `</div>`;
    return `<textarea class="fin" id="${id}" data-t="textarea" rows="3"></textarea>`;
  };
  // 선택형(승인/선택/라디오/체크)에는 "직접 입력" 칸을 항상 붙인다. 제안이 다 마음에 안 들 때 override.
  const CHOICE = new Set(['approve', 'select', 'radio', 'checkbox']);
  const manualField = (it) => CHOICE.has((it.input || {}).type)
    ? `<input class="fmanual" data-manual type="text" placeholder="↳ 위 선택지가 다 아니면 여기에 직접 입력 (입력하면 이게 우선)">`
    : '';
  const cards = items.map(it => `
    <section class="card" data-id="${escHtml(it.id)}">
      <div class="kind ${it.kind === 'issue' ? 'k-issue' : 'k-q'}">${it.kind === 'issue' ? '수정 제안' : '질문'}</div>
      <h2>${escHtml(it.heading || '')}</h2>
      ${it.detail ? `<p class="detail">${escHtml(it.detail)}</p>` : ''}
      ${it.proposal ? `<div class="proposal"><span>제안</span>${escHtml(it.proposal)}</div>` : ''}
      ${it.input && it.input.label ? `<label class="flabel">${escHtml(it.input.label)}</label>` : ''}
      ${field(it)}${manualField(it)}
    </section>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${escHtml(form.title || '세션 입력')}</title>
<style>
  :root{--bg:#1c1b1a;--panel:#262019;--panel2:#33291f;--ink:#f4efe9;--muted:#b6a99c;--accent:#d97757;--line:#4a3d31;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif;line-height:1.55;font-size:14px}
  header{padding:18px 22px 12px;position:sticky;top:0;background:linear-gradient(180deg,#1c1b1a,rgba(28,27,26,.92));border-bottom:1px solid var(--line);backdrop-filter:blur(4px)}
  header h1{margin:0 0 4px;font-size:18px}
  header p{margin:0;color:var(--muted);font-size:12.5px}
  main{padding:16px 22px 120px;display:flex;flex-direction:column;gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .kind{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px;margin-bottom:8px}
  .k-issue{background:rgba(217,119,87,.22);color:var(--accent)}
  .k-q{background:rgba(120,160,220,.22);color:#8ab4e8}
  .card h2{margin:0 0 6px;font-size:15px}
  .detail{margin:0 0 8px;color:#ddd2c7;white-space:pre-wrap}
  .proposal{background:var(--panel2);border-left:3px solid var(--accent);border-radius:6px;padding:8px 10px;margin:0 0 10px;color:#ecdfd3;white-space:pre-wrap}
  .proposal span{display:block;font-size:11px;font-weight:700;color:var(--accent);margin-bottom:3px}
  .flabel{display:block;font-size:12px;color:var(--muted);margin:4px 0 5px}
  .fin{width:100%;background:#1a1512;border:1px solid var(--line);border-radius:8px;color:var(--ink);padding:8px 10px;font:inherit;font-size:13px}
  .fin:focus{outline:none;border-color:var(--accent)}
  textarea.fin{resize:vertical}
  .fmanual{width:100%;margin-top:8px;background:#1a1512;border:1px dashed var(--line);border-radius:8px;color:var(--ink);padding:7px 10px;font:inherit;font-size:12.5px}
  .fmanual:focus{outline:none;border-color:var(--accent);border-style:solid}
  .fmanual::placeholder{color:#8a7d70}
  .frad,.fchk{display:flex;flex-direction:column;gap:6px}
  .rad,.chk{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
  input[type=radio],input[type=checkbox]{accent-color:var(--accent)}
  footer{position:fixed;bottom:0;left:0;right:0;padding:12px 22px;background:linear-gradient(0deg,#1c1b1a,rgba(28,27,26,.9));border-top:1px solid var(--line);display:flex;gap:10px;align-items:center}
  button{font:inherit;font-weight:700;border-radius:9px;padding:10px 18px;cursor:pointer;border:1px solid var(--line)}
  #send{background:var(--accent);color:#1c1b1a;border-color:var(--accent);flex:1}
  #send:disabled{opacity:.5;cursor:default}
  #cancel{background:transparent;color:var(--muted)}
  #progress{display:none;padding:12px 22px 100px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#cfc3b6}
  #progress.show{display:block}
  .done{color:#7bbf6a;font-weight:700}
</style></head>
<body>
  <header><h1>${escHtml(form.title || '세션 입력')}</h1><p>${escHtml(form.intro || '선택/입력 후 전송하면 이 세션이 이어서 작업합니다.')}</p></header>
  <main id="form">${cards}</main>
  <pre id="progress"></pre>
  <footer>
    <button id="cancel">닫기</button>
    <button id="send">전송하고 작업 진행 →</button>
  </footer>
<script>
  const CTX = ${JSON.stringify(ctx || {}).replace(/</g, '\\u003c')};
  const DKEY = 'sform-draft:' + (CTX.id || 'form');
  function fieldVal(card){
    const el = card.querySelector('[data-t]'); if (!el) return null;
    const t = el.dataset.t;
    if (t === 'checkbox') return [...el.querySelectorAll('input:checked')].map(x=>x.value);
    if (t === 'radio') { const c = el.querySelector('input:checked'); return c ? c.value : null; }
    return el.value;
  }
  // 최종 답변: '직접 입력'이 있으면 그게 선택지보다 우선
  function collect(){
    const ans = {};
    document.querySelectorAll('main .card').forEach(card => {
      const iid = card.dataset.id;
      const man = card.querySelector('.fmanual');
      const mv = man && man.value.trim();
      ans[iid] = mv ? man.value.trim() : fieldVal(card);
    });
    return ans;
  }
  // 초안 스냅샷: 선택값과 직접입력을 함께 저장/복원 (재열림·실패에도 안 날아감)
  function snapshot(){
    const s = {};
    document.querySelectorAll('main .card').forEach(card => {
      const man = card.querySelector('.fmanual');
      s[card.dataset.id] = { sel: fieldVal(card), man: man ? man.value : '' };
    });
    return s;
  }
  function restoreSnap(s){
    document.querySelectorAll('main .card').forEach(card => {
      const d = s[card.dataset.id]; if (!d) return;
      const el = card.querySelector('[data-t]');
      if (el) {
        const t = el.dataset.t, v = d.sel;
        if (t === 'checkbox') el.querySelectorAll('input').forEach(x => { x.checked = Array.isArray(v) && v.includes(x.value); });
        else if (t === 'radio') el.querySelectorAll('input').forEach(x => { x.checked = (x.value === v); });
        else el.value = (v == null ? '' : v);
      }
      const man = card.querySelector('.fmanual'); if (man) man.value = d.man || '';
    });
  }
  try { const d = JSON.parse(localStorage.getItem(DKEY) || 'null'); if (d) restoreSnap(d); } catch (e) {}
  document.addEventListener('input', () => { try { localStorage.setItem(DKEY, JSON.stringify(snapshot())); } catch (e) {} });
  const send = document.getElementById('send');
  const prog = document.getElementById('progress');
  send.addEventListener('click', async () => {
    try { localStorage.setItem(DKEY, JSON.stringify(snapshot())); } catch (e) {}
    send.disabled = true; send.textContent = '전송 중…';
    prog.classList.add('show'); prog.textContent = '세션을 이어서 실행 중…\\n';
    let r; try { r = await window.sessionForm.submit({ id: CTX.id, answers: collect() }); }
    catch (e) { r = { ok:false, error: String((e && e.message) || e) }; }
    if (!r || !r.ok) {
      prog.textContent += '\\n[오류] ' + ((r && r.error) || '전송 실패') + '\\n(입력은 저장돼 있어요. 다시 전송을 눌러도 됩니다.)';
      send.disabled = false; send.textContent = '다시 전송';
    }
  });
  document.getElementById('cancel').addEventListener('click', () => window.sessionForm.cancel());
  window.sessionForm.onOutput(d => { prog.classList.add('show'); prog.textContent += d.chunk; prog.scrollIntoView({block:'end'}); });
  window.sessionForm.onDone(d => {
    if (d.code === 0) { try { localStorage.removeItem(DKEY); } catch (e) {} }
    prog.textContent += '\\n\\n' + (d.code === 0
      ? '✅ 작업을 세션에 전달했습니다. 이 창은 닫아도 됩니다.'
      : '⚠️ 종료 코드 ' + d.code + (d.error ? ' — ' + d.error : '') + '\\n(입력은 저장돼 있어요.)');
  });
</script>
</body></html>`;
}

let formWin = null;
ipcMain.handle('open-form', (_e, { id }) => {
  try {
    const form = JSON.parse(fs.readFileSync(path.join(formsDir(), id + '.json'), 'utf8'));
    const html = renderFormHtml(form, { id });
    const htmlPath = path.join(formsDir(), id + '.html');
    fs.writeFileSync(htmlPath, html); // 렌더된 HTML도 공용 폴더에 남김
    if (formWin && !formWin.isDestroyed()) formWin.close();
    formWin = new BrowserWindow({
      width: 580, height: 760, title: form.title || '세션 입력', show: true,
      webPreferences: { preload: path.join(__dirname, 'form-preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    formWin.loadFile(htmlPath); // CTX(id)는 renderFormHtml이 HTML에 직접 박음(로드 전에 확정)
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('close-form', () => { if (formWin && !formWin.isDestroyed()) formWin.close(); return { ok: true }; });

function formatAnswers(form, answers) {
  const lines = [
    '아래는 사용자가 입력 폼에 채워 보낸 응답입니다. 이 결정에 따라 이어서 작업을 진행해주세요.',
    '',
  ];
  for (const it of (form.items || [])) {
    const a = answers[it.id];
    const val = Array.isArray(a) ? (a.length ? a.join(', ') : '(선택 없음)') : (a == null || a === '' ? '(응답 없음)' : a);
    lines.push(`■ ${it.heading || it.id}`);
    if (it.proposal) lines.push(`  제안: ${it.proposal}`);
    lines.push(`  → 사용자 응답: ${val}`);
    lines.push('');
  }
  return lines.join('\n');
}

function markFormDone(id, answers) {
  try {
    const dir = formsDir();
    const doneDir = path.join(dir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    try { fs.writeFileSync(path.join(doneDir, id + '.answer.json'), JSON.stringify(answers, null, 2)); } catch {}
    for (const ext of ['.json', '.html']) {
      const src = path.join(dir, id + ext);
      if (fs.existsSync(src)) { try { fs.renameSync(src, path.join(doneDir, id + ext)); } catch {} }
    }
  } catch {}
}

// ── 크로스세션 전달: 살아있는 세션 이름을 /list-agents로 찾아 SendMessage로 답을 그 터미널에 전달 ──
// (헤드리스 resume는 터미널에 안 보여서, 살아있는 세션이 있으면 그 세션으로 직접 보낸다.)
const peerNameCache = new Map(); // cwd -> { name, at }

// `claude -p "/list-agents"` 출력 파싱: "[idle] · name · /cwd · started ..." 형태
function parsePeerList(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (!line.includes('·')) continue;
    const parts = line.split('·').map(s => s.trim());
    // [status] · name · cwd · started ...  (status는 대괄호 포함)
    const statusIdx = parts.findIndex(p => /^\[(idle|busy)\]$/i.test(p));
    if (statusIdx === -1) continue;
    const name = parts[statusIdx + 1];
    const cwd = parts[statusIdx + 2];
    if (name && cwd && cwd.startsWith('/')) rows.push({ status: parts[statusIdx].replace(/[[\]]/g, '').toLowerCase(), name, cwd });
  }
  return rows;
}

function resolvePeerName(cwd) {
  const cached = peerNameCache.get(cwd);
  if (cached && Date.now() - cached.at < 120000) return Promise.resolve(cached.name);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(CLAUDE_BIN, ['-p', '/list-agents'], { cwd: os.homedir(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 60000);
    child.stdout.on('data', d => out += d);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const rows = parsePeerList(out);
      const real = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
      const match = rows.filter(r => r.cwd === cwd || r.cwd === real);
      const pick = match.find(r => r.status === 'idle') || match[0];
      const name = pick ? pick.name : null;
      if (name) peerNameCache.set(cwd, { name, at: Date.now() });
      resolve(name);
    });
  });
}

ipcMain.handle('submit-form', async (_e, { id, answers }) => {
  let form;
  try { form = JSON.parse(fs.readFileSync(path.join(formsDir(), id + '.json'), 'utf8')); }
  catch (err) { return { ok: false, error: '폼 파일을 읽지 못했어요: ' + String(err.message || err) }; }
  const prompt = formatAnswers(form, answers);
  const cwd = (form.cwd && fs.existsSync(form.cwd)) ? form.cwd : os.homedir(); // claude 실행 폴더 = 폼에 기록된 작업 폴더
  const send = (ch, data) => { if (formWin && !formWin.isDestroyed()) formWin.webContents.send(ch, data); };

  const runRelay = (name) => {
    send('form-output', { chunk: `‘${name}’ 세션(터미널)으로 전달 중…\n` });
    const relay =
      `너는 사용자의 폼 답변을 그 사용자의 다른(살아있는) 세션에 전달하는 중계자다. ` +
      `SendMessage 도구로 '${name}' 세션에게, 아래 ===사이의 텍스트를 요약·변형 없이 그대로 보내라(===표시는 빼고). ` +
      `보낸 뒤 즉시 멈추고 다른 작업은 하지 마라.\n===\n${prompt}\n===`;
    let child;
    try { child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'text', '--', relay], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
    child.stdout.on('data', d => send('form-output', { chunk: d.toString() }));
    child.stderr.on('data', d => send('form-output', { chunk: d.toString(), stderr: true }));
    child.on('close', (code) => {
      if (code === 0) { markFormDone(id, answers); send('form-output', { chunk: `\n✅ ‘${name}’ 세션 터미널로 전달했어요. 그 터미널에서 이어집니다.\n` }); }
      send('form-done', { code, mode: 'relay', name });
    });
    child.on('error', (err) => send('form-done', { code: -1, error: String(err.message || err) }));
    return { ok: true, mode: 'relay', name };
  };
  const runHeadless = (sid, note) => {
    send('form-output', { chunk: note });
    let child;
    try { child = spawn(CLAUDE_BIN, ['-p', '-r', sid, '--output-format', 'text', '--', prompt], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
    child.stdout.on('data', d => send('form-output', { chunk: d.toString() }));
    child.stderr.on('data', d => send('form-output', { chunk: d.toString(), stderr: true }));
    child.on('close', (code) => { if (code === 0) markFormDone(id, answers); send('form-done', { code, mode: 'headless' }); });
    child.on('error', (err) => send('form-done', { code: -1, error: String(err.message || err) }));
    return { ok: true, mode: 'headless', sessionId: sid };
  };

  // ⭐ 0순위: 소켓 직접 주입 (LLM/claude -p 없이 <1초, 그 세션 터미널에 즉시). 폼의 sessionId로 살아있는 pid 찾아 주입.
  if (form.sessionId) {
    send('form-output', { chunk: '세션에 전달 중…\n' });
    const ok = await injectBySessionId(form.sessionId, prompt);
    if (ok) {
      markFormDone(id, answers);
      send('form-output', { chunk: '✅ 세션 터미널로 전달했어요. 그 터미널에서 이어집니다.\n' });
      send('form-done', { code: 0, mode: 'socket' });
      return { ok: true, mode: 'socket' };
    }
    // 소켓 실패(세션 죽음/토큰 없음) → 아래 폴백
  }
  // 1순위(폴백): sessionName으로 크로스세션 relay(claude -p, 터미널 표시)
  if (form.sessionName) return runRelay(form.sessionName);
  // 2순위(폴백): sessionId로 헤드리스 resume (정확, 터미널 X)
  if (form.sessionId) return runHeadless(form.sessionId, `이 폼을 만든 세션(${form.sessionId.slice(0, 8)}…)으로 이어갑니다(헤드리스: 결과는 이 창에 표시)…\n`);
  // 3순위(구버전 폼): cwd로 살아있는 세션 이름을 찾아 전달, 없으면 최신 트랜스크립트로 헤드리스
  send('form-output', { chunk: '살아있는 세션을 찾는 중…\n' });
  const name = await resolvePeerName(cwd);
  if (name) return runRelay(name);
  const sessions = listSessionsForCwd(cwd);
  if (!sessions.length) return { ok: false, error: '이어갈 세션(살아있는 세션·트랜스크립트)을 찾지 못했어요' };
  return runHeadless(sessions[0].sessionId, '살아있는 세션을 못 찾아 헤드리스로 이어갑니다(터미널엔 안 보임)…\n');
});

// 패널 "메시지 보내기": tty 주입(iTerm/Terminal 전용) 대신 크로스세션 메시징으로 아무 세션에나 전달(Warp 포함)
ipcMain.handle('send-to-session', async (_e, { cwd, sessionId, text }) => {
  if (!text || !String(text).trim()) return { ok: false, error: '보낼 내용이 없어요' };
  // ⭐ 0순위: 소켓 직접 주입 (<1초). 펫이 넘긴 sessionId로 살아있는 pid 찾아 주입.
  if (sessionId && await injectBySessionId(sessionId, text)) return { ok: true, mode: 'socket' };
  // 폴백: claude -p relay
  const name = await resolvePeerName(cwd);
  if (!name) return { ok: false, error: '살아있는 세션을 찾지 못했어요 (크로스세션 메시징 필요 · Claude Code v2.1.224+)' };
  const relay =
    `SendMessage 도구로 '${name}' 세션에게, 아래 ===사이의 텍스트를 요약·변형 없이 그대로 보내라(===표시는 빼고). ` +
    `보낸 뒤 즉시 멈추고 다른 작업은 하지 마라.\n===\n${text}\n===`;
  return await new Promise((resolve) => {
    let child;
    try { child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'text', '--', relay], { cwd, env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch (err) { return resolve({ ok: false, error: String(err.message || err) }); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: '전송 시간이 초과됐어요' }); }, 90000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true, name } : { ok: false, error: '전송 실패 (code ' + code + ')' }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err.message || err) }); });
  });
});

// ── 사용량 (/usage) — 메인펫 HP바 + 사용량 탭 ──────────────
// claude -p "/usage"는 콜드 스타트라 느리다 → 캐시하고 주기 갱신.
let usageCache = { at: 0, data: null };
let usageInflight = null;

function parseUsage(text) {
  const grab = (label) => {
    const m = text.match(new RegExp(label.replace(/[()]/g, '\\$&') + ':\\s*(\\d+)%\\s*used\\s*·\\s*resets\\s*(.+)'));
    return m ? { pct: +m[1], resets: m[2].trim() } : null;
  };
  const weeks = [];
  const re = /Current week \(([^)]+)\):\s*(\d+)%\s*used\s*·\s*resets\s*(.+)/g;
  let m;
  while ((m = re.exec(text))) weeks.push({ model: m[1].trim(), pct: +m[2], resets: m[3].trim() });
  const spans = [];
  const re2 = /Last (24h|7d)\s*·\s*(\d+) requests\s*·\s*(\d+) sessions/g;
  while ((m = re2.exec(text))) spans.push({ span: m[1], requests: +m[2], sessions: +m[3] });
  return {
    session: grab('Current session'),
    weekAll: grab('Current week \\(all models\\)'),
    weeks,          // [{model:'all models'|'Fable'|…, pct, resets}]
    spans,          // [{span:'24h'|'7d', requests, sessions}]
    raw: text.trim(),
  };
}

function fetchUsage() {
  if (usageInflight) return usageInflight;
  usageInflight = new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(CLAUDE_BIN, ['-p', '/usage'], { cwd: os.homedir(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { usageInflight = null; return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60000);
    child.stdout.on('data', d => out += d);
    child.on('error', () => { clearTimeout(timer); usageInflight = null; resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const data = out.includes('%') ? parseUsage(out) : null;
      if (data) usageCache = { at: Date.now(), data };
      usageInflight = null;
      resolve(data);
    });
  });
  return usageInflight;
}

// 캐시 우선. force=true면 강제 갱신. (HP바는 캐시, 탭 열 때 force로 최신화)
ipcMain.handle('get-usage', async (_e, force) => {
  if (!force && usageCache.data && Date.now() - usageCache.at < 60000) return usageCache.data;
  const data = await fetchUsage();
  return data || usageCache.data || null;
});

// ── 잡담: 세션을 이어가는 대화 (claude -p --resume) ──────────

const PERSONA = '너는 맥 데스크탑 위에 사는 귀여운 펫이야. 사용자의 친구로서 가볍게 잡담을 나눠. ' +
  '답변은 1~3문장으로 짧고 친근하게, 반말 말고 다정한 존댓말로, 이모지를 조금 섞어서. ' +
  '코딩 질문이 오면 간단히 답하되 긴 작업은 "명령 탭에서 시켜주세요!"라고 안내해.';

const chatPids = new Set(); // 잡담용 프로세스는 시작/종료 알림에서 제외

ipcMain.handle('chat-claude', (_e, { message, sessionId }) => {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--append-system-prompt', PERSONA];
    if (sessionId) args.push('--resume', sessionId);
    args.push('--', message); // '-'로 시작하는 메시지가 플래그로 해석되는 걸 막는다
    const child = spawn(CLAUDE_BIN, args, {
      cwd: os.homedir(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) chatPids.add(child.pid);
    child.on('close', () => chatPids.delete(child.pid));
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', (e2) => resolve({ ok: false, error: String(e2.message || e2) }));
    child.on('close', () => {
      try {
        const j = JSON.parse(out);
        resolve({
          ok: !j.is_error,
          reply: j.result || '(응답 없음)',
          sessionId: j.session_id || sessionId || null,
        });
      } catch {
        resolve({ ok: false, error: (err || out || '응답을 해석하지 못했어요').slice(0, 500) });
      }
    });
  });
});

ipcMain.handle('stop-run', (_e, id) => {
  const child = runs.get(id);
  if (child) { child.kill('SIGTERM'); return true; }
  return false;
});

// ── 앱 라이프사이클 ─────────────────────────────────────────

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  upgradeHooksIfInstalled();
  cleanupStaleStatusFiles();
  createWindow();
  createTray();
  // 훅 미설치 시 설치 여부 확인 (창이 뜬 뒤)
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => promptInstallHooks(false).then(refreshTrayMenu), 1200);
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  for (const [, child] of runs) { try { child.kill('SIGTERM'); } catch {} }
  // 잡담용 자식(claude -p)도 함께 정리 — 방치하면 앱 종료 후 고아 프로세스가 남고,
  // 재실행 시 chatPids가 비어 있어 일반 세션 펫으로 오인된다.
  for (const pid of chatPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
});

// 비정상 종료(kill -9/크래시)로 SessionEnd 훅이 안 불려 남은 상태 파일을 청소한다.
// (기록이 HOOK_TTL의 몇 배로 오래된 것 = 확실히 죽은 세션)
function cleanupStaleStatusFiles() {
  const STALE_MS = 6 * 60 * 60 * 1000; // 6시간
  let files;
  try { files = fs.readdirSync(STATUS_DIR()); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(STATUS_DIR(), f);
    try {
      if (now - fs.statSync(fp).mtimeMs > STALE_MS) fs.unlinkSync(fp);
    } catch {}
  }
}
