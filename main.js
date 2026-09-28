const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage, systemPreferences, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { CodexProvider } = require('./lib/codex');
const codexHooks = require('./lib/codex-hooks');
const codex = new CodexProvider();

let win = null;
let tray = null;
// 이름 변경(Claude Session Pets → Hoo, 2026-09) 때 패키지 이름도 바뀌어 userData 폴더가 claude-session-pets → hoo로 옮겨졌다.
// 새 폴더가 아직 없으면 옛 폴더(펫 이미지·설정·localStorage)를 캐시만 빼고 복사해 그대로 이어 쓴다. (테스트 하니스 스텁 app엔 appData가 없어 try로 감쌈)
(function migrateUserData() {
  try {
    const neu = app.getPath('userData'), old = path.join(app.getPath('appData'), 'claude-session-pets');
    // ⚠️ Electron이 앱 코드보다 먼저 새 userData 폴더를 만들어 두므로 '폴더 존재'가 아니라 표시 파일로 판단한다(실측)
    const mark = path.join(neu, '.migrated-from-claude-session-pets');
    if (neu === old || fs.existsSync(mark) || !fs.existsSync(old)) return;
    const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', 'Shared Dictionary']);
    fs.mkdirSync(neu, { recursive: true });
    for (const n of fs.readdirSync(old)) if (!SKIP.has(n) && !n.startsWith('Singleton')) fs.cpSync(path.join(old, n), path.join(neu, n), { recursive: true, force: true });
    fs.writeFileSync(mark, new Date().toISOString());
  } catch (e) { console.error('[hoo] userData migrate', e && e.message); }
})();
// ⚠️ process-per-site 스위치 금지: 투명 창이 무작위로 흰 배경이 된다. 렌더러 공유는 lib/petwins.js의 window.open 창 풀로 한다
const runs = new Map(); // id -> child process (claude -p sessions we spawned)

const IMAGE_PATH = () => path.join(app.getPath('userData'), 'pet-image.png');

// 펫 창 관리자(lib/petwins.js): 세션 감지 루프 + 펫마다 독립 창 + 메인펫·패널·헤일로·딤·메뉴 창.
// (이전엔 화면 전체를 덮는 투명 창 하나에 모두 그렸다 — 스크린샷 창 선택·다른 앱 클릭을 막아 폐기)
let petMgr = null;
const runPids = new Set(); // 우리가 띄운 claude -p / codex exec 자식 pid — 세션펫으로 만들지 않는다
function createPetManager() {
  petMgr = require('./lib/petwins').createPetManager({ app, BrowserWindow, screen, ipcMain, deps: {
    listSessions: listSessionsRows,
    isQuiet: (p) => runPids.has(p.pid) || !!p.chat,
    runningCount: () => runs.size,
  } });
  petMgr.start();
  win = petMgr.mainWin; // 다이얼로그 부모 등 기존 참조용
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
  tray.setToolTip('Hoo');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const installed = hooksInstalled();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '펫 보이기/숨기기', click: () => petMgr && petMgr.toggleVisible() },
    { label: '펫 이미지 변경…', click: () => pickImage() },
    { type: 'separator' },
    installed
      ? { label: '상태 훅: 설치됨 ✓', enabled: false }
      : { label: '상태 훅 설치…', click: async () => { await promptInstallHooks(true); refreshTrayMenu(); } },
    ...(installed ? [{ label: '상태 훅 제거', click: () => { uninstallHooks(); refreshTrayMenu(); } }] : []),
    { type: 'separator' },
    { label: codexHooks.installed() ? 'Codex 상태 훅 재설치…' : 'Codex 상태 훅 설치…', click: () => {
      try { codexHooks.install(); refreshTrayMenu(); dialog.showMessageBox(win, { message: 'Codex 훅 설치 완료', detail: 'Codex에서 /hooks를 열어 새 훅을 신뢰해주세요. 폼 모드는 세션펫 우클릭 메뉴에서 켤 수 있어요.' }); }
      catch (err) { dialog.showErrorBox('Codex 훅 설치 실패', err.message); }
    } },
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
  if (petMgr && petMgr.mainWin) petMgr.mainWin.webContents.send('image-changed', url);
  return url;
}

ipcMain.handle('pick-image', () => pickImage());

ipcMain.handle('save-image', (_e, dataUrl) => {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(IMAGE_PATH(), Buffer.from(b64, 'base64'));
  return true;
});

// 메인펫 커스텀 이미지 삭제 → 기본 캐릭터(도트 어미새)로 복귀
ipcMain.handle('delete-saved-image', () => {
  try { fs.unlinkSync(IMAGE_PATH()); } catch {}
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
# Hoo(데스크탑 펫) 상태 훅: 세션별 작업 상태(+현재 작업 내용)를 데스크탑 펫이 읽도록 기록한다.
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
approve는 승인/거절/수정요청 라디오로 렌더된다. options는 select/radio/checkbox에만 쓴다. 하나의 폼에 여러 항목을 담아도 된다. 모든 선택형 항목에는 앱이 '직접 입력' 선택지와 '첨언' 칸을 자동으로 붙이니 '기타/직접입력' 같은 선택지는 넣지 마라. 응답의 '첨언'은 고른 처리를 따르되 참고하라는 뜻이다.
가독성: heading은 한 줄로 짧게. detail·proposal은 한 줄에 한 요점만 쓰고 요점마다 줄바꿈으로 나눠라(긴 한 문단 금지). 코드·파일·함수·설정 이름은 \`백틱\`으로 감싸라. 선택지는 짧은 본문 뒤 괄호에 부연을 붙이면 부연이 아래 작은 글씨로 표시된다.
요약·그림(선택 필드, 적극 사용): 항목마다 "summary"(결론 한 줄)를 넣고 detail은 3~5줄로 줄여라. 흐름·상태 전이·전후 비교는 글 대신 "diagram": [{"label": "현재", "steps": ["READY", {"text": "consume 안 함", "tone": "bad"}, "멈춤"]}, {"label": "수정 후", "steps": ["READY", "consume", {"text": "CONFIRM", "tone": "good"}]}] 로 그려라(tone: bad|good|warn|now, 단계에 "note"로 작은 설명 가능). 여러 대상 비교는 "table": {"columns": [...], "rows": [[...], ...]} 로.'''
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

    ntype = ""
    if state == "waiting":
        # Notification은 권한 요청/질문(진짜 입력 대기) 외에 턴 종료 60초 뒤 유휴 알림("waiting for your input")이나
        # 기타 안내로도 발화된다. 실측: 긴 도구 실행 중 발화한 알림이 working을 waiting으로 덮어 "입력 필요"로 오표시됨.
        # → notification_type이 있으면 permission_prompt/elicitation_dialog만, 없으면 메시지가 권한/질문일 때만 waiting.
        ntype = str(data.get("notification_type") or "")
        msg = str(data.get("message") or "")
        if ntype:
            real = ntype in ("permission_prompt", "elicitation_dialog")
        else:
            real = bool(re.search(r"permission|needs your|approv|question|allow", msg, re.I)) and not re.search(r"waiting for your input", msg, re.I)
        if not real:
            sys.exit(0)
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

    out = {"state": state, "cwd": cwd, "session_id": sid, "ts": time.time(), "event": ev}
    if ntype:
        out["ntype"] = ntype  # 진단용: 어떤 알림이 waiting을 만들었는지
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
            # 가장 가까운 표시를 따른다: <enc>=켜기, <enc>.off=끄기. 아무 표시도 없으면 전체 기본값(.default-on 파일)
            on = None
            for base in (cwd, os.path.realpath(cwd)):
                cur = base
                while True:
                    enc = re.sub(r"[^A-Za-z0-9]", "-", cur)
                    if os.path.exists(os.path.join(fmdir, enc)):
                        on = True
                        break
                    if os.path.exists(os.path.join(fmdir, enc + ".off")):
                        on = False
                        break
                    parent = os.path.dirname(cur)
                    if parent == cur:
                        break
                    cur = parent
                if on is not None:
                    break
            if on is None:
                on = os.path.exists(os.path.join(fmdir, ".default-on"))
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
    CUR=0; if [ -e "$M" ]; then CUR=1; elif [ -e "$M.off" ]; then CUR=0; elif [ -e "$DIR/.default-on" ]; then CUR=1; fi
    if [ "$ARG" = on ]; then WANT=1; elif [ "$ARG" = off ]; then WANT=0; else WANT=$((1-CUR)); fi
    if [ "$WANT" = 1 ]; then rm -f "$M.off"; : > "$M"; echo "🟢 세션 폼 모드 ON — 입력이 필요할 때 펫이 폼을 띄웁니다";
    else rm -f "$M"; if [ -e "$DIR/.default-on" ]; then : > "$M.off"; fi; echo "⚪️ 세션 폼 모드 OFF (이 폴더)"; fi
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
    title: 'Hoo',
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

ipcMain.on('quit-app', () => app.quit());

ipcMain.handle('get-home', () => os.homedir());

// ── Claude CLI 프로세스 모니터링 ─────────────────────────────

function execFileP(cmd, args, strict = false) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => err && strict ? reject(err) : resolve(stdout || ''));
  });
}

// "mm:ss.ss" / "hh:mm:ss" 형태의 누적 CPU 시간을 초(실수)로 변환
// Claude Code 내부 도우미 프로세스 판별 — 사용자 세션이 아니므로 펫을 만들지 않는다.
// 실측(2026-09, Claude Code 데몬 도입 후): `claude daemon run …`, `claude bg-pty-host --bg-pty-host /tmp/cc-daemon-<uid>/<id>/spare/….pty.sock`,
// `claude bg-spare --bg-spare …claim.sock`, `ClaudeCode.app/Contents/MacOS/claude --bg-pty-host …`가 실행 파일 이름이 'claude'라
// 기존 필터를 통과했고, cwd가 `/private/tmp/cc-daemon-…/spare`여서 "spare"라는 이름의 펫이 여러 마리 떴다.
const INTERNAL_CLAUDE_ARGS = /(^|\s)(daemon|bg-pty-host|bg-spare)(\s|$)|--bg-(pty-host|spare)(\s|$)|--spawned-by(\s|$)/;
function isInternalClaudeHelper(command, cwd) {
  const rest = command.trim().split(/\s+/).slice(1).join(' ');
  if (INTERNAL_CLAUDE_ARGS.test(rest)) return true;
  if (cwd && /^(\/private)?\/tmp\/cc-daemon-/.test(cwd)) return true;
  return false;
}

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
// 반환: { state: 'midturn'|'ended'|'unknown', reason: 'assistant-tool_use'|'assistant-end'|'user-prompt'|null,
//        tsMs: 판정에 쓴 메시지 항목의 timestamp(ms) 또는 null }
// ⚠️ ageSec은 파일 mtime이 아니라 이 tsMs로 재야 한다. Claude Code는 세션이 놀고 있어도
// artifact-autoreact-ledger·artifact-comment-monitor·file-history-snapshot 같은 부기 항목을 계속 덧붙여
// mtime을 갱신하므로, mtime을 활동으로 읽으면 유휴 세션이 "작업 중→완료"를 반복한다(실측 버그).
function parseTranscriptTail(filePath) {
  let tail;
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    tail = buf.toString('utf8');
  } catch { return { state: 'unknown', reason: null, tsMs: null }; }

  const lines = tail.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const msg = o && o.message;
    if (!msg || typeof msg !== 'object') continue;
    const tsMs = o.timestamp ? (Date.parse(o.timestamp) || null) : null;
    const role = msg.role;
    if (role === 'assistant') {
      return msg.stop_reason === 'tool_use' ? { state: 'midturn', reason: 'assistant-tool_use', tsMs } : { state: 'ended', reason: 'assistant-end', tsMs };
    }
    if (role === 'user') {
      // 사용자 프롬프트 제출 후 응답 대기. content는 문자열(순수 텍스트) 또는
      // 배열(text/tool_result 블록 혼합)일 수 있다. 문자열 또는 text 블록이면 프롬프트.
      const c = msg.content;
      if (typeof c === 'string' || (Array.isArray(c) && c.some(b => b && b.type === 'text'))) return { state: 'midturn', reason: 'user-prompt', tsMs };
      // tool_result(role=user) / attachment 등은 건너뛰고 계속 위로
    }
  }
  return { state: 'unknown', reason: null, tsMs: null };
}
function parseTranscriptFile(filePath) { return parseTranscriptTail(filePath).state; }
// 응답 없이 이만큼 지난 user 프롬프트 = 실행되지 않은(대기열에만 남은) 입력. 살아있는 작업으로 보지 않는다.
const STALE_PROMPT_SEC = 600;

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
  return rows.map(r => {
    const t = parseTranscriptTail(r.file);
    // 활동 시각 = 마지막 '메시지' 항목의 timestamp (없으면 mtime 폴백). 부기 항목 추가는 활동이 아니다.
    const ageSec = t.tsMs ? Math.max(0, (now - t.tsMs) / 1000) : (now - r.mtimeMs) / 1000;
    const stalePrompt = t.reason === 'user-prompt' && ageSec > STALE_PROMPT_SEC;
    return { sessionId: r.sessionId, state: stalePrompt ? 'ended' : t.state, reason: t.reason, ageSec, stalePrompt };
  });
}

// ── 세션 등록 파일(~/.claude/sessions/<pid>.json) — Claude Code가 직접 쓰는 1차 소스 ──
// 실측(2026-09, 데몬 도입 후): 사용자가 세션을 백그라운드 잡으로 '파킹'하면 원래 터미널 프로세스(kind interactive)는
// parkedJobId만 남는 껍데기가 되고, 실제 세션은 pty 호스트 아래 `~/.local/share/claude/versions/<ver> --session-id <sid> …`
// (kind 'bg', jobId)로 돈다. 실행 파일 이름이 'claude'가 아니라 ps 필터가 놓쳐 펫도 없고 폼 배달(sid→pid)도 실패했다.
// 등록 파일은 pid·sessionId·cwd·name·messagingSocketPath를 정확히 담고 있어 트랜스크립트 mtime 휴리스틱보다 우월하다.
function readSessionRegistry() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(path.join(HOOK_DIR(), 'sessions')); } catch { return map; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HOOK_DIR(), 'sessions', f), 'utf8'));
      const pid = Number(j.pid || f.replace(/\.json$/, ''));
      if (!pid) continue;
      map.set(pid, { pid, sessionId: j.sessionId || null, cwd: j.cwd || null, name: j.name || null, kind: j.kind || null, status: j.status || null, parkedJobId: j.parkedJobId || null, jobId: j.jobId || null, socketPath: j.messagingSocketPath || null });
    } catch {}
  }
  return map;
}
// ps에서 잡은 procs와 등록 파일을 합친다. allProcs = pid → ps 정보(전 프로세스).
//  · 등록된 pid가 살아있고 procs에 없으면 추가(실행 파일 이름이 뭐든 세션이다)
//  · parkedJobId가 있는 껍데기는 그 잡(jobId 일치)이 살아있으면 제거(한 세션에 펫 하나)
//  · 등록 항목이 있는 proc는 sessionId/cwd/name을 등록값으로 고정(reg)
function mergeRegistry(procs, allProcs, registry) {
  const aliveJobs = new Set();
  for (const [pid, r] of registry) if (r.jobId && allProcs.has(pid)) aliveJobs.add(r.jobId);
  for (const [pid, r] of registry) {
    if (!allProcs.has(pid)) continue;
    if (r.parkedJobId && aliveJobs.has(r.parkedJobId)) { const i = procs.findIndex(p => p.pid === pid); if (i >= 0) procs.splice(i, 1); continue; }
    let p = procs.find(x => x.pid === pid);
    if (!p) { const a = allProcs.get(pid); p = { pid, ppid: a.ppid, cpu: a.cpu, cpusec: a.cpusec, etime: a.etime, tty: a.tty, command: a.command, cwd: null, chat: chatPids.has(pid) }; procs.push(p); }
    p.reg = r;
    if (r.cwd) p.cwd = r.cwd;
  }
  return procs;
}

async function computeProcs() {
  const out = await execFileP('ps', ['-axo', 'pid=,ppid=,pcpu=,cputime=,etime=,tty=,command='], true);
  const procs = [];
  const allProcs = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, cpu, cputime, etime, tty, command] = m;
    allProcs.set(Number(pid), { ppid: Number(ppid), cpu: Number(cpu), cpusec: cputimeToSec(cputime), etime, tty: tty === '??' ? null : tty, command: command.trim() });
    const first = command.trim().split(/\s+/)[0] || '';
    const base = path.basename(first);
    // 제외/판정은 실행 파일 경로(first token)로만 한다. command 전체로 검사하면
    // `claude -p "Electron 버그 고쳐줘"`처럼 프롬프트에 든 단어 때문에 오탐/미탐이 난다.
    // Claude.app(데스크탑)과 이 앱(Electron)은 제외.
    if (/Claude\.app|Claude Helper|claude-session-pets|Hoo\.app|Electron/.test(first)) continue;
    // 실행 파일 basename이 정확히 'claude'이거나, node로 claude 스크립트를 실행 중인 경우.
    // 경계(\b/끝)를 둬서 claude-monitor, claude-squad 같은 무관한 도구를 오탐하지 않는다.
    const isClaude = base === 'claude' ||
      (/(^|\/)node$/.test(first) && /\/claude(\s|$)/.test(command)) ||
      /\/\.local\/(bin|share)\/claude$/.test(first) ||
      /\/\.local\/share\/claude\/versions\/[^/]+$/.test(first) ||   // 데몬이 띄우는 버전 바이너리 (--session-id …)
      /\/\.claude\/local\/claude$/.test(first);
    if (!isClaude) continue;
    if (isInternalClaudeHelper(command)) continue; // 데몬/spare pty 도우미 — 세션 아님
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
  mergeRegistry(procs, allProcs, readSessionRegistry());
  // 작업 디렉토리 조회 (lsof 일괄) — 등록 파일에 cwd가 있는 건 이미 채워짐
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
    // cwd가 cc-daemon 아래인 것도 내부 도우미(spare) — 2차 제외 (등록 파일에 있는 세션은 예외)
    for (let i = procs.length - 1; i >= 0; i--) if (!procs[i].reg && isInternalClaudeHelper(procs[i].command, procs[i].cwd)) procs.splice(i, 1);
  }
  // 등록 파일에는 있는데 lsof를 못 돌린(방금 추가된) proc의 cwd는 등록값(mergeRegistry가 채움). 그래도 없으면 lsof 한 번 더
  const noCwd = procs.filter(p => !p.cwd);
  if (noCwd.length) {
    try {
      const out3 = await execFileP('lsof', ['-a', '-p', noCwd.map(p => p.pid).join(','), '-d', 'cwd', '-Fn']);
      let cur = null;
      for (const l of out3.split('\n')) { if (l.startsWith('p')) cur = Number(l.slice(1)); else if (l.startsWith('n') && cur != null) { const p = procs.find(x => x.pid === cur); if (p && !p.cwd) p.cwd = l.slice(1); } }
    } catch {}
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
    // 등록 파일로 sessionId를 아는 proc은 그 세션 행을 정확히 집고, 나머지만 위치(pid순↔mtime순) 휴리스틱으로 배정
    const taken = new Set();
    const assigned = new Map();
    for (const p of group) if (p.reg && p.reg.sessionId) { const row = sessions.find(r => r.sessionId === p.reg.sessionId); if (row) { assigned.set(p, row); taken.add(row); } else assigned.set(p, { sessionId: p.reg.sessionId, state: 'unknown', ageSec: Infinity, stalePrompt: false }); }
    const pool = sessions.filter(r => !taken.has(r));
    let k = 0;
    for (const p of group) if (!assigned.has(p)) assigned.set(p, pool[k++] || null);
    group.forEach((p, i) => {
      const s = assigned.get(p) || null;
      p.tstate = s ? s.state : 'unknown';
      p.tage = s ? s.ageSec : Infinity;
      p.tstale = !!(s && s.stalePrompt); // 응답 없이 오래된 user 프롬프트(실행 안 된 대기열 입력) — 훅이 working이어도 유휴로 본다
      // 1순위: 트랜스크립트로 찾은 session_id의 훅. 2순위(트랜스크립트 실패 시): cwd로 직접 매칭한 훅.
      let hs = s ? readHookStatus(s.sessionId) : null;
      if (!hs && hookRows[i]) {
        const hr = hookRows[i];
        hs = { state: hr.state, ageSec: hr.ageSec, task: hr.task, taskKind: hr.taskKind };
      }
      // 펫이 "자기 세션"을 식별하도록 session_id를 실어준다(폼을 세션 단위로 매칭하기 위함)
      p.sessionId = (s && s.sessionId) || (hookRows[i] && hookRows[i].sessionId) || null;
      // 크로스세션 세션 이름(myproj-e4 등) — 같은 폴더 다중 세션 구분용 펫 라벨. ~/.claude/sessions/<pid>.json에 있음.
      p.sessionName = (p.reg && p.reg.name) || readSessionName(p.pid);
      p.kind = p.reg ? p.reg.kind : null; // 'interactive' | 'bg'(파킹된 백그라운드 잡)
      p.hookState = hs ? hs.state : null;
      p.hookAge = hs ? hs.ageSec : Infinity;
      p.hookTask = hs ? hs.task : null;
      p.hookTaskKind = hs ? hs.taskKind : null;
    });
  }
  return procs;
}
ipcMain.handle('list-claude-procs', computeProcs);
let lastClaudeRows = [];
async function listSessionsRows() {
  const results = await Promise.allSettled([computeProcs(), codex.list()]);
  if (results[0].status === 'fulfilled') lastClaudeRows = results[0].value.map(p => ({ ...p, provider: 'claude', id: 'claude:' + p.pid }));
  return [...lastClaudeRows, ...(results[1].status === 'fulfilled' ? results[1].value : codex.rows)];
}
ipcMain.handle('list-sessions', () => listSessionsRows());
// 폼 모드 전체 기본값: ~/.claude/session-pets-formmode/.default-on 파일이 있으면 표시 없는 폴더·세션도 폼 모드
const FORM_DEFAULT_FILE = () => path.join(os.homedir(), '.claude', 'session-pets-formmode', '.default-on');
function setFormDefault(on) {
  const f = FORM_DEFAULT_FILE();
  if (on) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'on'); } else { try { fs.unlinkSync(f); } catch {} }
  return fs.existsSync(f);
}
// 설치(첫 실행) 기본값 = 켜짐. 한 번만 적용하고, 이후엔 사용자가 설정 탭에서 끈 상태를 존중한다
function initFormDefaultOnce() {
  try {
    const flag = path.join(app.getPath('userData'), 'form-default-initialized');
    if (fs.existsSync(flag)) return;
    setFormDefault(true); fs.writeFileSync(flag, new Date().toISOString());
  } catch {}
}
ipcMain.handle('form-default', (_e, value) => { try { return { ok: true, on: value == null ? fs.existsSync(FORM_DEFAULT_FILE()) : setFormDefault(!!value) }; } catch (e) { return { ok: false, error: String(e.message || e) }; } });
ipcMain.handle('codex-form-mode', (_e, id) => { try { return { ok: true, on: codexHooks.toggle(id) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('interrupt-session', async (_e, { provider, sessionId, pid }) => {
  try {
    if (provider === 'codex') return await codex.interrupt(sessionId);
    const rows = await computeProcs();
    if (!rows.some(p => p.pid === pid)) throw Error('실행 중인 Claude 세션이 없어요');
    process.kill(pid, 'SIGTERM'); return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('focus-agent-session', async (_e, { provider, sessionId }) => {
  if (provider !== 'codex' || !/^[a-f0-9-]{36}$/i.test(sessionId || '')) return { ok: false };
  // Desktop registers codex:// deep links; use exact thread ID, never a cwd title guess.
  try { await require('electron').shell.openExternal('codex://threads/' + sessionId); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('run-codex', (_e, { id, prompt, cwd }) => {
  try {
    if (!prompt || typeof prompt !== 'string') throw Error('프롬프트가 필요해요');
    const child = codex.run({ prompt, cwd: cwd || os.homedir(), onOutput: (chunk, stderr) => {
      if (petMgr) petMgr.panelSend('run-output', { id, chunk, stderr });
    }, onDone: ({ code, error }) => { runs.delete(id); runPids.delete(child.pid); if (petMgr) petMgr.panelSend('run-done', { id, code, error }); } });
    runs.set(id, child); if (child.pid) runPids.add(child.pid); return { ok: true, pid: child.pid };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('chat-codex', (_e, { message, sessionId }) => new Promise(resolve => {
  try {
    const id = crypto.randomUUID();
    const child = codex.run({ prompt: message, cwd: os.homedir(), sessionId, chat: true, onOutput: () => {}, onDone: r => {
      runs.delete(id); resolve({ ok: r.code === 0, reply: r.reply, sessionId: r.sessionId, error: r.error || (r.code ? 'Codex 실행 실패' : null) });
    } }); runs.set(id, child);
  } catch (err) { resolve({ ok: false, error: err.message }); }
}));


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
    // iTerm2는 셸을 .app 안의 실행파일이 아니라 `~/Library/Application Support/iTerm2/iTermServer-<ver>`
    // 데몬(launchd 직속)으로 띄우므로 조상 체인에 .app 경로가 없다 → 데몬 이름으로 iTerm2를 인식.
    // (안 하면 nohost → "창을 찾지 못했어요"가 뜬다. 실측: claude ← zsh ← login ← iTermServer-3.6.11 ← launchd)
    if (/\/iTermServer(-[^/]*)?$/.test(node.comm)) return { bundlePath: null, bundleId: 'com.googlecode.iterm2', appName: 'iTerm2' };
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

// IntelliJ/VS Code 등 창이 여러 개인 GUI 앱: 창 제목에 프로젝트 폴더명이 들어가므로,
// 그 이름을 포함하는 창을 System Events로 찾아 AXRaise(정확히 해당 프로젝트 창을 앞으로).
// (앱 통째 activate와 달리 다른 프로젝트 창이 떠 있어도 정확한 창을 고른다. Accessibility 권한 필요.)
const GUI_WINDOW_FOCUS = `
on run argv
  set appName to item 1 of argv
  set needle to item 2 of argv
  tell application "System Events"
    if not (exists process appName) then return "noproc"
    tell process appName
      set frontmost to true
      repeat with w in windows
        try
          if (name of w) contains needle then
            perform action "AXRaise" of w
            return "ok"
          end if
        end try
      end repeat
    end tell
  end tell
  return "notfound"
end run`;

// 손쉬운 사용 권한 요청: 시스템 다이얼로그는 1분에 한 번만(더블클릭마다 뜨면 성가심), 설정의 손쉬운 사용 화면은 매번 연다.
// (실측: 실행당 1회로 제한했더니, 사용자가 설정에서 항목을 제거한 뒤 다시 눌러도 다이얼로그가 안 떠 막막했음)
let accessibilityPromptedAt = 0;
function requestAccessibility() {
  const now = Date.now();
  if (now - accessibilityPromptedAt > 60000) { accessibilityPromptedAt = now; try { systemPreferences.isTrustedAccessibilityClient(true); } catch {} }
  try { shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); } catch {}
}
ipcMain.handle('focus-session', async (_e, { pid, tty, cwd }) => {
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

  // 그 외(IntelliJ/VS Code 등): 프로젝트 폴더명으로 정확한 창을 먼저 raise 시도
  if (host) {
    // System Events로 창을 다루려면 손쉬운 사용(Accessibility) 권한이 필요하다.
    // ⚠️ 실측: 앱이 ad-hoc 서명(지정 요구사항 = cdhash)이라 재빌드마다 서명이 바뀌고, macOS TCC는 서명 기준으로 권한을 기억하므로
    // 빌드할 때마다 이전에 준 권한이 무효화된다. 그때 osascript는 -25211("보조 접근이 허용되지 않습니다")로 실패하는데
    // 이를 인식하지 못하고 아래 '앱 통째 activate'로 폴백해 "정확한 창 raise가 안 된다"로 보였다.
    // → 먼저 권한을 확인하고, 없으면 시스템 프롬프트(설정 열기)를 띄우고 'accessibility'로 알린다.
    if (systemPreferences && typeof systemPreferences.isTrustedAccessibilityClient === 'function' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      requestAccessibility();
      return { ok: false, error: 'accessibility' };
    }
    // 창 제목 후보: cwd 폴더명 → 상위 폴더명들(홈 제외). IntelliJ 창 제목은 "프로젝트 – 파일"이라 하위 모듈 폴더(cwd)명이
    // 없고 프로젝트(상위) 이름만 있을 수 있다(실측: 프로젝트 루트 아래 myproj/module 같은 하위 모듈에서 세션을 띄운 경우).
    const needles = [];
    if (cwd && !cwd.startsWith('pid:')) {
      let dir = cwd; const home = os.homedir();
      while (dir && dir !== '/' && dir !== home && needles.length < 4) { const b = path.basename(dir); if (b) needles.push(b); dir = path.dirname(dir); }
    }
    for (const needle of needles) {
      const r = await new Promise((res) =>
        execFile('osascript', ['-e', GUI_WINDOW_FOCUS, host.appName, needle], { timeout: 8000 }, (err, out, se) =>
          res({ err, out: (out || '').trim(), se: String(se || '') })));
      if (!r.err && r.out === 'ok') return { ok: true, app: host.appName, window: needle };
      if (r.err && /not authoriz|1743|-1743/i.test(r.se)) return { ok: false, error: 'automation' };
      if (r.err && /25211|assistive|보조 접근/i.test(r.se)) { requestAccessibility(); return { ok: false, error: 'accessibility' }; }
      if (r.out === 'noproc') break;
      // notfound(제목에 폴더명 없음) → 다음 상위 폴더명으로 재시도, 다 실패하면 아래 앱 통째 activate로 폴백
    }
    // 폴백: 앱 번들을 앞으로 (특정 창 매칭 실패 시)
    const openArgs = host.bundlePath ? ['-a', host.bundlePath] : ['-b', host.bundleId];
    const r = await new Promise((res) =>
      execFile('open', openArgs, (err) => res(err)));
    if (!r) return { ok: true, app: host.appName };
    return { ok: false, error: String(r.message || r) };
  }
  return { ok: false, error: 'nohost' };
});

// 세션 작업 폴더를 Finder에서 연다
ipcMain.handle('open-folder', (_e, cwd) => {
  try {
    if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: 'nofolder' };
    execFile('open', [cwd], () => {});
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
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
  runs.set(id, child); if (child.pid) runPids.add(child.pid);
  const send = (ch, data) => { if (petMgr) petMgr.panelSend(ch, data); };
  child.stdout.on('data', d => send('run-output', { id, chunk: d.toString() }));
  child.stderr.on('data', d => send('run-output', { id, chunk: d.toString(), stderr: true }));
  child.on('close', (code) => {
    runs.delete(id); runPids.delete(child.pid);
    send('run-done', { id, code });
  });
  child.on('error', (err) => {
    runs.delete(id); runPids.delete(child.pid);
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

const codexFormPaths = new Map();
function formFile(id, ext = '.json') {
  if (codexFormPaths.has(id)) return codexFormPaths.get(id).replace(/\.json$/, ext);
  if (!/^[^/\\.][^/\\]*$/.test(id || '') || id.includes('..')) throw Error('잘못된 폼 ID');
  return path.join(formsDir(), id + ext);
}

// 특정 세션의 미처리 폼 목록 (공용 폴더에서 sessionId로 필터)
ipcMain.handle('list-forms', (_e, sessionId, provider) => {
  if (provider === 'codex') {
    const row = codex.rows.find(r => r.sessionId === sessionId);
    if (!row?.cwd) return [];
    try {
      const dir = path.join(row.cwd, '.session-pets', 'forms');
      return fs.readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => {
        try {
          const file = path.join(dir, f); if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024) return [];
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (j.provider !== 'codex' || j.sessionId !== sessionId) return [];
          const id = 'codex-' + crypto.createHash('sha256').update(file).digest('hex'); codexFormPaths.set(id, file);
          return [{ id, title: j.title || f, sessionId, mtimeMs: fs.statSync(file).mtimeMs }];
        } catch { return []; }
      }).sort((a,b) => b.mtimeMs - a.mtimeMs);
    } catch { return []; }
  }
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
const FORM_CUSTOM = '__custom__'; // 폼 선택지의 '직접 입력' 센티널 값
function renderFormHtml(form, ctx) {
  const items = Array.isArray(form.items) ? form.items : [];
  // 본문 텍스트: escape 후 가벼운 마크업만 허용 (`코드`, **굵게**, 빈 줄=문단). XSS 안전(escape가 먼저)
  //  · 백틱 없는 식별자(camelCase·snake_case·a.b 체인·key=value·fn())도 코드 글꼴로 자동 표시
  //  · 줄바꿈 없는 긴 문단은 문장마다 한 줄(• 목록)로 나눠 훑어보기 쉽게
  const inline = (raw) => {
    const codes = []; // 백틱 코드는 먼저 떼어 두었다가 복원 (자동 표시·굵게 처리에서 제외)
    let t = String(raw).replace(/`([^`\n]+)`/g, (_, c) => '\u0000' + (codes.push(c) - 1) + '\u0000');
    t = escHtml(t).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[^\w.$&#])((?:[A-Za-z_$][\w$]*)(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*(?:\(\))?(?:=[\w.-]+)?)(?![\w$])/g, (m, pre, id) => {
      const code = /[a-z][A-Z]/.test(id) || /[A-Za-z]_[A-Za-z]/.test(id) || /[A-Za-z]\.[A-Za-z]/.test(id) || /=/.test(id) || /\(\)$/.test(id);
      return code ? pre + '<code>' + id + '</code>' : m;
    });
    t = t.replace(/→|-&gt;/g, '<span class="arr">→</span>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + escHtml(codes[+i]) + '</code>').replace(/\n/g, '<br>');
  };
  const SENT = /(?<=[가-힣A-Za-z0-9)\]%][.!?])\s+(?=\S)/; // 문장 끝(마침표 뒤 공백). v1.2.3·e.g. 같은 점은 공백이 없어 안 끊김
  const rich = (t) => String(t == null ? '' : t).split(/\n\s*\n/).map(para => {
    para = para.trim(); if (!para) return '';
    const sents = !para.includes('\n') && para.length > 110 ? para.split(SENT) : [para];
    return sents.length > 1 ? '<ul class="sents">' + sents.map(x => '<li>' + inline(x) + '</li>').join('') + '</ul>' : '<p>' + inline(para) + '</p>';
  }).join('');
  // 선택지 "본문 (부연)" → 본문 + 아래 작은 부연 줄 (값은 원문 그대로)
  // 흐름도: diagram = [{ label, steps: [단계 | {text, tone:'bad'|'good'|'warn'|'now', note}] }] 또는 단계 배열 하나
  const TONES = new Set(['bad', 'good', 'warn', 'now']);
  const diagramHtml = (d) => {
    if (!d) return '';
    const rows = Array.isArray(d) && d.length && (typeof d[0] === 'string' || (d[0] && d[0].text != null)) ? [{ steps: d }] : (Array.isArray(d) ? d : [d]);
    const row = (r) => {
      const steps = Array.isArray(r && r.steps) ? r.steps : [];
      if (!steps.length) return '';
      const li = steps.map(st => { const o = typeof st === 'string' ? { text: st } : (st || {}); const tone = TONES.has(o.tone) ? ' t-' + o.tone : '';
        return `<li class="step${tone}"><span>${inline(o.text == null ? '' : o.text)}</span>${o.note ? `<small>${inline(o.note)}</small>` : ''}</li>`; }).join('');
      return `<div class="flow">${r.label ? `<div class="flowlabel">${inline(r.label)}</div>` : ''}<ol class="steps">${li}</ol></div>`;
    };
    const body = rows.map(row).join(''); return body ? `<div class="diagram">${body}</div>` : '';
  };
  // 비교표: table = { columns: [...], rows: [[...], ...] }
  const tableHtml = (tb) => {
    if (!tb || !Array.isArray(tb.rows) || !tb.rows.length) return '';
    const cols = Array.isArray(tb.columns) ? tb.columns : [];
    return `<div class="tblwrap"><table class="tbl">${cols.length ? '<thead><tr>' + cols.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead>' : ''}<tbody>` +
      tb.rows.map(r => '<tr>' + (Array.isArray(r) ? r : [r]).map(c => `<td>${inline(c == null ? '' : c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
  };
  const optLabel = (o) => { const m = String(o).match(/^(.+?)\s*[(（]([^()（）]+)[)）]\s*$/); return m ? escHtml(m[1]) + '<span class="osub">' + inline(m[2]) + '</span>' : escHtml(o); };
  const field = (it) => {
    const inp = it.input || {};
    const id = 'f_' + escHtml(it.id);
    const type = inp.type || 'textarea';
    const opts = Array.isArray(inp.options) ? inp.options : [];
    const rec = (o) => (inp.default != null && o === inp.default) ? '<em class="rec">추천</em>' : '';
    // 선택지 끝에 '직접 입력'을 붙인다(폼에 이미 직접 입력/기타가 있으면 생략). 값은 센티널 CUSTOM
    const hasOwnCustom = (list) => list.some(o => /직접\s*입력|^기타/.test(String(o)));
    if (type === 'text')
      return `<input class="fin" id="${id}" data-t="text" type="text" placeholder="${escHtml(inp.placeholder || '')}" value="${escHtml(inp.default || '')}">`;
    if (type === 'textarea')
      return `<textarea class="fin" id="${id}" data-t="textarea" rows="4" placeholder="${escHtml(inp.placeholder || '')}">${escHtml(inp.default || '')}</textarea>`;
    if (type === 'select')
      return `<select class="fin" id="${id}" data-t="select">` +
        opts.map(o => `<option${o === inp.default ? ' selected' : ''}>${escHtml(o)}</option>`).join('') +
        (hasOwnCustom(opts) ? '' : `<option value="${FORM_CUSTOM}">✏️ 직접 입력</option>`) + `</select>`;
    if (type === 'radio' || type === 'approve') {
      const choices = type === 'approve' ? ['승인', '거절', '수정 요청'] : opts;
      return `<div class="opts" id="${id}" data-t="radio">` + choices.map((o, i) =>
        `<label class="opt"><input type="radio" name="${id}" value="${escHtml(o)}"${(o === inp.default || (i === 0 && inp.default == null)) ? ' checked' : ''}><span class="otext">${optLabel(o)}</span>${rec(o)}</label>`).join('') +
        (hasOwnCustom(choices) ? '' : `<label class="opt opt-custom"><input type="radio" name="${id}" value="${FORM_CUSTOM}"><span class="otext">✏️ 직접 입력</span></label>`) + `</div>`;
    }
    if (type === 'checkbox')
      return `<div class="opts" id="${id}" data-t="checkbox">` + opts.map(o =>
        `<label class="opt chk"><input type="checkbox" value="${escHtml(o)}"><span class="otext">${optLabel(o)}</span>${rec(o)}</label>`).join('') +
        (hasOwnCustom(opts) ? '' : `<label class="opt chk opt-custom"><input type="checkbox" value="${FORM_CUSTOM}"><span class="otext">✏️ 직접 입력</span></label>`) + `</div>`;
    return `<textarea class="fin" id="${id}" data-t="textarea" rows="4"></textarea>`;
  };
  // 선택형(승인/선택/라디오/체크) 아래 텍스트 칸: 평소엔 '첨언'(선택한 처리를 따르되 참고), '직접 입력' 선택 시 그 자체가 답
  const CHOICE = new Set(['approve', 'select', 'radio', 'checkbox']);
  const manualField = (it) => CHOICE.has((it.input || {}).type)
    ? `<div class="manual"><label><span class="mlabel">첨언 (선택)</span> <small class="mhint">선택한 처리를 따르되, 여기 적은 내용을 참고해 진행합니다</small></label><textarea class="fmanual" data-manual rows="2" placeholder="덧붙일 요청이나 주의사항이 있으면 적어 주세요"></textarea></div>`
    : '';
  const total = items.length;
  const cards = items.map((it, n) => `
    <section class="card" data-id="${escHtml(it.id)}">
      <div class="chead"><span class="num">${n + 1}${total > 1 ? ' / ' + total : ''}</span><span class="kind ${it.kind === 'issue' ? 'k-issue' : 'k-q'}">${it.kind === 'issue' ? '확인 필요' : '질문'}</span></div>
      <h2>${escHtml(it.heading || '')}</h2>
      ${it.summary ? `<p class="summary">${inline(it.summary)}</p>` : ''}
      <div class="cbody">
        <div class="cmain">
          ${diagramHtml(it.diagram)}
          ${it.detail ? `<div class="detail">${rich(it.detail)}</div>` : ''}
          ${tableHtml(it.table)}
          ${it.proposal ? `<div class="proposal"><div class="ptitle">💡 제안</div>${rich(it.proposal)}</div>` : ''}
        </div>
        <div class="ask">
          ${it.input && it.input.label ? `<div class="flabel">${escHtml(it.input.label)}</div>` : ''}
          ${field(it)}${manualField(it)}
        </div>
      </div>
    </section>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${escHtml(form.title || '세션 입력')}</title>
<style>
  /* 문서형 밝은 테마 + 넓은 창에서 2단(왼쪽 설명·오른쪽 선택지 고정) — 사용자 선택(2026-09) */
  :root{color-scheme:light;--bg:#f7f5f2;--panel:#ffffff;--panel2:#faf7f3;--ink:#1c1a18;--body:#3a3531;--muted:#756c63;--accent:#c4552f;--accent-bg:#fdf1ec;--line:#e9e3dc;--line2:#d8cfc5;--ok:#2f8a3e;--bad:#c93b2b;--warn:#b7791f;--head:96px}
  *{box-sizing:border-box}
  html{scroll-padding-top:calc(var(--head) + 16px)}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif;line-height:1.72;font-size:15.5px;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1180px;margin:0 auto;padding:0 32px}
  header{position:sticky;top:0;z-index:2;background:rgba(247,245,242,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
  header .wrap{padding-top:20px;padding-bottom:14px}
  header h1{margin:0 0 4px;font-size:21px;line-height:1.4;letter-spacing:-.01em}
  header p{margin:0;color:var(--muted);font-size:14px}
  main.wrap{padding-top:24px;padding-bottom:calc(var(--foot,90px) + 40px);display:flex;flex-direction:column;gap:22px} /* ⚠️ .wrap의 padding 단축 속성이 덮지 않게 main.wrap으로 */
  .card{background:var(--panel);border-radius:14px;padding:24px 28px 26px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 0 0 1px var(--line)}
  .chead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .num{font-size:12px;font-weight:700;color:var(--muted);background:#f1ede8;border-radius:6px;padding:2px 8px;font-variant-numeric:tabular-nums}
  .kind{font-size:12px;font-weight:700;border-radius:999px;padding:2px 10px}
  .k-issue{background:#fbe6dd;color:#a8431e}
  .k-q{background:#e3edfa;color:#2b5d9f}
  .card h2{margin:0 0 6px;font-size:19px;line-height:1.45;letter-spacing:-.01em}
  .summary{margin:0 0 4px;font-size:16.5px;font-weight:600;color:var(--ink);line-height:1.6}
  .cbody{margin-top:14px}
  .cmain{display:flex;flex-direction:column;gap:14px;min-width:0}
  .detail{color:var(--body)}
  .detail p,.proposal p{margin:0 0 8px}
  .detail p:last-child,.proposal p:last-child{margin-bottom:0}
  .sents{margin:0 0 8px;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
  .sents:last-child{margin-bottom:0}
  .sents li{position:relative;padding-left:16px}
  .sents li::before{content:'';position:absolute;left:3px;top:.74em;width:5px;height:5px;border-radius:50%;background:#b3a699}
  .proposal .sents li::before{background:var(--accent)}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:#f3efea;border-radius:4px;padding:1px 4px;color:#8a3a18;overflow-wrap:anywhere}
  b{color:#000}
  .arr{color:var(--accent);font-weight:700;padding:0 1px}
  .proposal{background:#fdf6f2;border-left:4px solid var(--accent);border-radius:8px;padding:12px 16px;color:var(--body)}
  .ptitle{font-size:13px;font-weight:700;color:var(--accent);margin-bottom:4px}
  /* 흐름도 */
  .diagram{display:flex;flex-direction:column;gap:10px;background:var(--panel2);border-radius:10px;padding:14px 16px}
  .flow{display:flex;flex-direction:column;gap:6px}
  .flowlabel{font-size:12.5px;font-weight:700;color:var(--muted)}
  .steps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;align-items:stretch;gap:6px 0}
  .step{display:flex;flex-direction:column;justify-content:center;background:#fff;border:1.5px solid var(--line2);border-radius:8px;padding:6px 11px;font-size:14px;line-height:1.45;max-width:260px}
  .step small{font-size:12px;color:var(--muted);margin-top:1px}
  .step:not(:last-child){margin-right:26px;position:relative}
  .step:not(:last-child)::after{content:'→';position:absolute;right:-21px;top:50%;transform:translateY(-50%);color:#a3968a;font-weight:700}
  .t-bad{border-color:#e7a79e;background:#fdf0ee;color:#8f2418}
  .t-good{border-color:#9fd1a7;background:#eef8f0;color:#1f6b2c}
  .t-warn{border-color:#e8c78f;background:#fdf6e7;color:#7a4f0e}
  .t-now{border-color:var(--accent);box-shadow:0 0 0 2px rgba(196,85,47,.15)}
  /* 비교표 */
  .tblwrap{overflow-x:auto}
  .tbl{border-collapse:collapse;width:100%;font-size:14px}
  .tbl th,.tbl td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
  .tbl th{font-size:12.5px;color:var(--muted);font-weight:700;background:var(--panel2)}
  /* 선택 영역 */
  .ask{margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}
  .flabel{font-size:15.5px;font-weight:700;color:var(--ink);margin:0 0 10px}
  .opts{display:flex;flex-direction:column;gap:8px}
  .opt{display:flex;align-items:center;gap:12px;padding:11px 14px;border:1.5px solid var(--line2);border-radius:10px;background:#fff;cursor:pointer;transition:border-color .12s,background .12s}
  .opt:hover{border-color:#bfb2a5;background:#fcfaf8}
  .opt:has(input:checked){border-color:var(--accent);background:var(--accent-bg)}
  .opt input{margin:0;width:18px;height:18px;flex:none;accent-color:var(--accent)}
  .otext{flex:1;font-size:15px;color:var(--ink);line-height:1.5}
  .osub{display:block;font-size:13px;color:var(--muted);margin-top:2px;line-height:1.5}
  .opt-custom .otext{color:#9a4a2a}
  .rec{font-style:normal;font-size:11.5px;font-weight:700;color:#fff;background:var(--ok);border-radius:999px;padding:1px 8px;flex:none}
  .fin{width:100%;background:#fff;border:1.5px solid var(--line2);border-radius:10px;color:var(--ink);padding:10px 13px;font:inherit;font-size:15px}
  .fin:focus,.fmanual:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(196,85,47,.15)}
  textarea.fin{resize:vertical;min-height:96px}
  select.fin{appearance:auto}
  .manual{margin-top:14px}
  .manual label{display:block;font-size:13.5px;font-weight:700;color:var(--muted);margin-bottom:6px}
  .manual small{font-weight:400;color:#948a80}
  .manual.is-custom .mlabel{color:var(--accent)}
  .manual.is-custom .fmanual{border-color:var(--accent);border-style:solid}
  .fmanual{width:100%;background:#fff;border:1.5px dashed var(--line2);border-radius:10px;color:var(--ink);padding:9px 13px;font:inherit;font-size:14.5px;resize:vertical;min-height:46px}
  .fmanual.need{border-color:var(--bad)!important;box-shadow:0 0 0 3px rgba(201,59,43,.15)}
  .fmanual::placeholder,.fin::placeholder{color:#aaa096}
  /* 넓은 창: 2단 — 왼쪽 설명, 오른쪽 선택지(스크롤해도 따라옴) */
  @media (min-width: 980px){
    .cbody{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,1fr);gap:28px;align-items:start}
    .ask{margin-top:0;padding-top:0;border-top:none;position:sticky;top:calc(var(--head) + 16px)}
  }
  footer{position:fixed;bottom:0;left:0;right:0;background:rgba(247,245,242,.96);backdrop-filter:blur(8px);border-top:1px solid var(--line)}
  footer .wrap{padding-top:14px;padding-bottom:16px;display:flex;gap:10px;align-items:center}
  button{font:inherit;font-size:15px;font-weight:700;border-radius:10px;padding:11px 18px;cursor:pointer;border:1.5px solid var(--line2);background:#fff;color:var(--ink)}
  #send{background:var(--accent);color:#fff;border-color:var(--accent);flex:1}
  #send kbd{font:inherit;font-size:12px;font-weight:600;opacity:.8;margin-left:8px}
  #send:disabled{opacity:.5;cursor:default}
  #cancel{background:transparent;color:var(--muted)}
  #cancelwork{background:transparent;color:var(--bad);border-color:#ebb7af}
  #cancelwork:disabled{opacity:.5;cursor:default}
  #progress{display:none;margin:0 auto;max-width:1180px;padding:12px 32px 110px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#4a443e}
  #progress.show{display:block}
</style></head>
<body>
  <header><div class="wrap"><h1>${escHtml(form.title || '세션 입력')}</h1><p>${escHtml(form.intro || '선택/입력 후 전송하면 이 세션이 이어서 작업합니다.')}</p></div></header>
  <main id="form" class="wrap">${cards}</main>
  <pre id="progress"></pre>
  <footer><div class="wrap">
    <button id="cancel">닫기</button>
    <button id="cancelwork">작업 취소</button>
    <button id="send">전송하고 작업 진행 →<kbd>⌘↩</kbd></button>
  </div></footer>
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
  const CUSTOM = ${JSON.stringify(FORM_CUSTOM)};
  const isCustom = (v) => Array.isArray(v) ? v.includes(CUSTOM) : v === CUSTOM;
  // 최종 답변: 선택형이면 { choice, note } (첨언) 또는 { custom } (직접 입력). 첨언이 없으면 선택값 그대로
  function collect(){
    const ans = {};
    document.querySelectorAll('main .card').forEach(card => {
      const iid = card.dataset.id;
      const man = card.querySelector('.fmanual');
      const sel = fieldVal(card);
      if (!man) { ans[iid] = sel; return; }
      const txt = man.value.trim();
      if (isCustom(sel)) {
        const rest = Array.isArray(sel) ? sel.filter(v => v !== CUSTOM) : null;
        ans[iid] = rest && rest.length ? { choice: rest, custom: txt } : { custom: txt };
      } else ans[iid] = txt ? { choice: sel, note: txt } : sel;
    });
    return ans;
  }
  // 아래 칸 모드 전환: '직접 입력' 선택 → 이름·안내를 '직접 입력'으로, 아니면 '첨언'
  function updateManual(card){
    const box = card.querySelector('.manual'); if (!box) return;
    const custom = isCustom(fieldVal(card)); const ta = box.querySelector('.fmanual');
    box.classList.toggle('is-custom', custom);
    box.querySelector('.mlabel').textContent = custom ? '직접 입력' : '첨언 (선택)';
    box.querySelector('.mhint').textContent = custom ? '위 선택지 대신 이 내용대로 처리합니다' : '선택한 처리를 따르되, 여기 적은 내용을 참고해 진행합니다';
    ta.placeholder = custom ? '원하는 처리를 직접 적어 주세요' : '덧붙일 요청이나 주의사항이 있으면 적어 주세요';
    if (!custom) ta.classList.remove('need');
  }
  function updateAll(){ document.querySelectorAll('main .card').forEach(updateManual); }
  document.addEventListener('change', (e) => { const card = e.target.closest && e.target.closest('.card'); if (!card) return; updateManual(card);
    if (e.target.value === CUSTOM && e.target.checked !== false) { const ta = card.querySelector('.fmanual'); if (ta) ta.focus(); } });
  // 직접 입력을 골랐는데 비어 있으면 전송을 막는다
  function missingCustom(){
    for (const card of document.querySelectorAll('main .card')) {
      const ta = card.querySelector('.fmanual');
      if (ta && isCustom(fieldVal(card)) && !ta.value.trim()) { ta.classList.add('need'); ta.focus(); ta.scrollIntoView({ block: 'center' }); return true; }
    }
    return false;
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
  updateAll();
  document.addEventListener('input', (e) => { if (e.target.classList && e.target.classList.contains('fmanual')) e.target.classList.remove('need'); });
  document.addEventListener('input', () => { try { localStorage.setItem(DKEY, JSON.stringify(snapshot())); } catch (e) {} });
  const send = document.getElementById('send');
  const prog = document.getElementById('progress');
  send.addEventListener('click', async () => {
    try { localStorage.setItem(DKEY, JSON.stringify(snapshot())); } catch (e) {}
    if (missingCustom()) return;
    send.disabled = true; send.textContent = '전송 중…';
    prog.classList.add('show'); prog.textContent = '세션을 이어서 실행 중…\\n';
    let r; try { r = await window.sessionForm.submit({ id: CTX.id, answers: collect() }); }
    catch (e) { r = { ok:false, error: String((e && e.message) || e) }; }
    if (!r || !r.ok) {
      prog.textContent += '\\n[오류] ' + ((r && r.error) || '전송 실패') + '\\n(입력은 저장돼 있어요. 다시 전송을 눌러도 됩니다.)';
      send.disabled = false; send.textContent = '다시 전송';
    }
  });
  const setFoot = () => { const r = document.documentElement.style; r.setProperty('--foot', document.querySelector('footer').offsetHeight + 'px'); r.setProperty('--head', document.querySelector('header').offsetHeight + 'px'); };
  setFoot(); window.addEventListener('resize', setFoot);
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !send.disabled) { e.preventDefault(); send.click(); } });
  document.getElementById('cancel').addEventListener('click', () => window.sessionForm.cancel());
  // '작업 취소': 이 작업이 필요 없었을 때, 세션에 취소를 전달해 진행 중이던 작업을 멈추게 한다
  const cw = document.getElementById('cancelwork');
  cw.addEventListener('click', async () => {
    cw.disabled = true; send.disabled = true; cw.textContent = '취소 전달 중…';
    prog.classList.add('show'); prog.textContent = '작업 취소를 세션에 전달 중…\\n';
    let r; try { r = await window.sessionForm.submit({ id: CTX.id, cancel: true }); }
    catch (e) { r = { ok:false, error: String((e && e.message) || e) }; }
    if (!r || !r.ok) {
      prog.textContent += '\\n[오류] ' + ((r && r.error) || '전송 실패');
      cw.disabled = false; send.disabled = false; cw.textContent = '작업 취소';
    }
  });
  window.sessionForm.onOutput(d => { prog.classList.add('show'); prog.textContent += d.chunk; prog.scrollIntoView({block:'end'}); });
  window.sessionForm.onDone(d => {
    if (d.code === 0) {
      try { localStorage.removeItem(DKEY); } catch (e) {}
      prog.textContent += '\\n\\n✅ 세션에 전달했습니다. 잠시 후 이 창이 닫힙니다…';
      prog.scrollIntoView({block:'end'});
      setTimeout(() => window.sessionForm.cancel(), 1200); // cancel() = 창 닫기(close-form)
    } else {
      prog.textContent += '\\n\\n⚠️ 종료 코드 ' + d.code + (d.error ? ' — ' + d.error : '') + '\\n(입력은 저장돼 있어요.)';
      send.disabled = false; send.textContent = '다시 전송';
    }
  });
</script>
</body></html>`;
}

let formWin = null;
ipcMain.handle('open-form', (_e, { id }) => {
  try {
    const form = JSON.parse(fs.readFileSync(formFile(id), 'utf8'));
    const html = renderFormHtml(form, { id });
    const htmlPath = formFile(id, '.html');
    fs.writeFileSync(htmlPath, html); // 렌더된 HTML도 공용 폴더에 남김
    if (formWin && !formWin.isDestroyed()) formWin.close();
    // 기본 창을 넉넉하게(가독성): 폭 1240(2단 배치), 높이는 작업 영역에 맞춰 최대 1000, 화면 가운데. 좁히면 1단으로
    let fwa = { width: 1400, height: 1000 }; try { fwa = screen.getPrimaryDisplay().workArea; } catch {}
    const fw = Math.min(1240, fwa.width - 60), fh = Math.min(1000, fwa.height - 40);
    formWin = new BrowserWindow({
      width: fw, height: fh, minWidth: 560, minHeight: 480, center: true, title: form.title || '세션 입력', show: true, backgroundColor: '#f7f5f2',
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
    const show = (v) => Array.isArray(v) ? (v.length ? v.join(', ') : '(선택 없음)') : (v == null || v === '' ? '(응답 없음)' : v);
    lines.push(`■ ${it.heading || it.id}`);
    if (it.proposal) lines.push(`  제안: ${it.proposal}`);
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      if (a.choice != null) lines.push(`  → 사용자 응답: ${show(a.choice)}`);
      if (a.custom != null) lines.push(a.choice != null ? `  → 직접 입력(추가 항목): ${a.custom || '(비어 있음)'}` : `  → 사용자 응답(직접 입력 — 선택지 대신 이대로 처리): ${a.custom || '(비어 있음)'}`);
      if (a.note) lines.push(`  → 첨언(위 선택대로 처리하되 참고): ${a.note}`);
    } else lines.push(`  → 사용자 응답: ${show(a)}`);
    lines.push('');
  }
  return lines.join('\n');
}

// '작업 취소' 선택 시 세션에 보낼 문구: 진행 중이던 작업을 멈추게 한다
function formatCancel(form) {
  const lines = [
    "사용자가 이 입력 폼을 검토한 뒤 '작업 취소'를 선택했습니다.",
    '요청했던(또는 진행 중이던) 작업이 실제로는 필요 없다고 판단한 것입니다.',
    '지금 하던 작업을 중단하고, 이 건과 관련된 추가 변경은 하지 말고 대기해 주세요. 이 작업은 취소되었습니다.',
  ];
  if (form.title) { lines.push(''); lines.push(`[취소된 폼: ${form.title}]`); }
  return lines.join('\n');
}

function markFormDone(id, answers) {
  try {
    const dir = path.dirname(formFile(id));
    const filename = path.basename(formFile(id), '.json');
    const doneDir = path.join(dir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    try { fs.writeFileSync(path.join(doneDir, filename + '.answer.json'), JSON.stringify(answers, null, 2)); } catch {}
    for (const ext of ['.json', '.html']) {
      const src = formFile(id, ext);
      if (fs.existsSync(src)) { try { fs.renameSync(src, path.join(doneDir, filename + ext)); } catch {} }
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

ipcMain.handle('submit-form', async (_e, { id, answers, cancel }) => {
  let form;
  try { form = JSON.parse(fs.readFileSync(formFile(id), 'utf8')); }
  catch (err) { return { ok: false, error: '폼 파일을 읽지 못했어요: ' + String(err.message || err) }; }
  const prompt = cancel ? formatCancel(form) : formatAnswers(form, answers);
  const doneAnswers = cancel ? { __cancelled: true } : answers; // done/으로 남길 기록
  const cwd = (form.cwd && fs.existsSync(form.cwd)) ? form.cwd : os.homedir(); // claude 실행 폴더 = 폼에 기록된 작업 폴더
  const send = (ch, data) => { if (formWin && !formWin.isDestroyed()) formWin.webContents.send(ch, data); };

  if (form.provider === 'codex') {
    try {
      // A form answer is a new prompt after the form-producing turn has stopped.
      const result = await codex.send(form.sessionId, prompt);
      markFormDone(id, doneAnswers);
      send('form-done', { code: 0, mode: result.mode });
      return result;
    } catch (err) { return { ok: false, error: err.message }; }
  }

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
      if (code === 0) { markFormDone(id, doneAnswers); send('form-output', { chunk: `\n✅ ‘${name}’ 세션 터미널로 전달했어요. 그 터미널에서 이어집니다.\n` }); }
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
    child.on('close', (code) => { if (code === 0) markFormDone(id, doneAnswers); send('form-done', { code, mode: 'headless' }); });
    child.on('error', (err) => send('form-done', { code: -1, error: String(err.message || err) }));
    return { ok: true, mode: 'headless', sessionId: sid };
  };

  // ⭐ 0순위: 소켓 직접 주입 (LLM/claude -p 없이 <1초, 그 세션 터미널에 즉시). 폼의 sessionId로 살아있는 pid 찾아 주입.
  if (form.sessionId) {
    send('form-output', { chunk: '세션에 전달 중…\n' });
    const ok = await injectBySessionId(form.sessionId, prompt);
    if (ok) {
      markFormDone(id, doneAnswers);
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
ipcMain.handle('send-to-session', async (_e, { cwd, sessionId, text, provider }) => {
  if (provider === 'codex') { try { return await codex.send(sessionId, text); } catch (err) { return { ok: false, error: err.message }; } }
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
ipcMain.handle('get-usage', async (_e, force, provider) => {
  if (provider === 'codex') { try { if (force) codex.usageCache = null; return await codex.usage(); } catch { return null; } }
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
  try { codexHooks.refreshScript(); } catch {} // Codex 훅 스크립트도 최신으로(기존 세션도 다음 호출부터 새 규칙)
  initFormDefaultOnce();
  cleanupStaleStatusFiles();
  createPetManager();
  createTray();
  // 훅 미설치 시 설치 여부 확인 (창이 뜬 뒤)
  if (win) win.webContents.once('did-finish-load', () => {
    setTimeout(() => promptInstallHooks(false).then(refreshTrayMenu), 1200);
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (petMgr) petMgr.stop();
  codex.close();
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
