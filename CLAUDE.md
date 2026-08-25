# CLAUDE.md — Claude Session Pets 개발 가이드

macOS 데스크탑 펫(Electron). 실행 중인 Claude CLI 세션들을 감시해 세션마다 작은 펫을 띄우고,
작업 상태·현재 작업 내용을 말풍선으로 보여준다. 기능 개요는 README.md 참고.

## 파일 구조

- `main.js` — Electron 메인. 프로세스 감시(ps/lsof), 상태 훅 설치/업그레이드, 트랜스크립트 판독, tty 명령 주입, `claude -p` 실행
- `pet.js` — 렌더러. 메인펫/세션펫 상태머신, 말풍선, 패널 UI, 이미지 배경제거
- `pet.html` — 마크업 + 전체 CSS (별도 CSS 파일 없음)
- `preload.js` — IPC 브리지 (펫 렌더러용)
- `form-preload.js` — 세션 폼 창(BrowserWindow) 전용 IPC 브리지 (`window.sessionForm.submit/cancel/onOutput/onDone`)
- `start.sh` — 개발 실행용 (`npx electron .` 백그라운드)
- `build/icon.icns` — 앱 아이콘 (어른새 SVG를 스쿼클 배경에 얹어 렌더 → icns)

## 세션 상태 감지 (우선순위)

1. **훅** (가장 정확): Claude Code 생명주기 훅이 `~/.claude/session-pets-status/<session_id>.json`에
   `{state, task, cwd, ts}` 기록. state: working/waiting/idle. `task`는 현재 작업 내용 한 줄 요약.
   훅↔프로세스 매칭은 2단계: ① 트랜스크립트로 찾은 session_id로 `readHookStatus` ② 실패 시 **상태 파일의
   `cwd` 필드로 직접 매칭**(`readHookStatusByCwd`). ②가 없으면, **세션 시작 후 프로젝트 폴더가 이동/개명되면**
   현재 cwd 인코딩의 트랜스크립트 디렉토리가 없어 session_id를 못 찾고 → 훅 무시 → CPU 폴백으로 "작업 중" 고착됨(겪은 버그).
2. **트랜스크립트**: `~/.claude/projects/<인코딩된 cwd>/*.jsonl`의 마지막 turn 경계 (`deriveTranscriptState`).
   cwd 인코딩은 **비영숫자 전부 `-` 치환** (`my_project`→`my-project`, 연속 대시 유지).
   훅 매칭(sessionId)도 이 디렉토리에서 찾으므로 인코딩이 틀리면 (위 cwd 폴백이 없던 시절) 훅까지 통째로 실패함
3. **CPU 폴백**: 누적 CPU 시간 증가 여부 (렌더러 `sessionState`)

### 상태 훅 (중요)

- **원본은 `main.js`의 `HELPER_SRC`** (파이썬 스크립트를 JS 템플릿 리터럴로 내장).
  `~/.claude/session-pets-hook.py`는 생성물이므로 직접 수정 금지 — `HELPER_SRC`를 수정할 것
- 설치: `~/.claude/settings.json`의 hooks에 UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification/SessionStart/SessionEnd 등록
- **PostToolUse→working**: 권한 승인/AskUserQuestion 답변은 발화되는 훅이 없어서, 도구 종료 시점에
  waiting→working으로 복귀시키는 용도 (없으면 승인 후에도 "입력 필요"가 계속 떠 있음)
- **waiting 가드**: Notification은 턴 종료 60초 후 유휴 알림에도 발화되므로,
  직전 상태가 working/waiting일 때만 waiting을 기록 (아니면 idle을 덮어써서 "작업 완료"가 "입력 필요"로 바뀜)
- **앱 시작 시 `upgradeHooksIfInstalled()`가 기존 설치를 자동으로 최신화** (설정에 `session-pets-hook.py` 마커가 있으면)
- 스크립트 파일 갱신은 실행 중인 세션에도 **즉시 적용** (매 호출마다 python3가 새로 읽음).
  settings.json의 이벤트 추가/변경은 **새로 시작하는 세션부터** 적용
- `task` 요약 규칙 (PreToolUse의 tool_name/tool_input에서 추출, 120자 안전 상한):
  TodoWrite→진행 중 항목 activeForm / Bash→description / Edit·Write→"파일명 수정 중" / Read→"…읽는 중" /
  Grep·Glob→"코드 검색 중" / WebSearch·WebFetch→"웹 조사 중" / Task→"설명 (에이전트)" / TaskCreate→작업 제목 /
  TaskUpdate·TaskList·TaskGet·ToolSearch·mcp__* → None(직전 task 유지)

## 세션 펫 상태머신 (pet.js `SessionPet`)

- 상태: idle | walk | work | done | wait | drag | fall | bye
- `sticky`('done'|'wait'): 클릭으로 확인할 때까지 유지되는 말풍선
- `working` + `workTask`: 작업 중이면 클릭/드래그해도 말풍선 유지. 말풍선 텍스트는 `workBubbleText()` = "🏃 {task 또는 '작업 중…'}"
- 말풍선 갱신은 **task가 바뀔 때만** (detectEvents에서 `t.task !== task` 비교)
- 드래그 후 공중에서 놓으면 `fall` 상태로 중력 낙하(GRAVITY 공유), 착지 시 `landRestore()`가 모드에 맞는 상태로 복귀
- 드래그/낙하 중(`inAir()`)에는 setWorking/setDone 등이 상태를 바꾸지 않고 말풍선·플래그만 갱신
- 임시 말풍선(우클릭 "여기예요!", 더블클릭 이미지 변경) 후에는 `restoreBubble()`로 원래 말풍선 복원
- 세션펫 말풍선(.sbubble)은 최대 250px에서 줄바꿈 (자르지 않음 — "…" 금지가 사용자 요구사항)
- **좌우 반전(`this.flip`)**: `render()`에서 `facing = (dir===1) !== flip ? 1 : -1`.
  요소 3층 구조로 회전 피봇과 반전을 분리한다:
  - `.swrap` (66×66 flex, 하단중앙 정렬) — 레이아웃만
  - `.sbody` (inline-block, **이미지 크기**로 shrink) — **회전(rotate)만**. origin=**바닥중앙(50% 100%)** → 바닥 딛고 위에서 좌우로 갸우뚱(역진자).
  - `.sbounce` (inline-block, origin **바닥 50% 100%**) — **스케일(scaleY 늘썩)만**. ⚠️ **translateY 금지**(아래 참조).
  - `.ssprite` img (`max 66px`, `origin:50% 50%`) — **반전 scaleX만**(`render()`가 `spriteEl`에 설정). 회전과 별개라 각도가 안 뒤집힘

  ### ⭐ "회전축(피봇)이 우하단/위아래로 움직인다" — 최종 결론 (2026-07, 여러 세션 헤맴)
  사용자 요구: **"캐릭터 바닥에 점을 찍으면 그 점이 고정된 채 위에서만 갸우뚱"** (바닥 고정 역진자).
  이게 안 되고 "바닥점이 위아래로 움직인다 / 우하단으로 쏠린다"였던 **진짜 원인은 두 가지**였고, 오래 ①만 붙들다 ②를 놓쳤다:
  1. **회전축 위치**: 축이 바닥이 아니라 몸통 중앙/픽셀 무게중심에 있었음(코드가 그새 무게중심으로 드리프트).
     무게중심은 비대칭(부리·모자 등)이라 한쪽으로 밀리고, 미러(scaleX) 시 반대편으로 튀어 **우하단 쏠림**.
     → **해결: `cx=0.5, cy=1`(바닥중앙) 고정.** `cx=0.5`는 미러해도 `1-cx=0.5`라 좌우로 안 튄다.
  2. **바운스의 `translateY`** (← 결정적, 오래 놓침): walk/work/idle 애니메이션이 `translateY`로 캐릭터를 통째로
     위아래로 들어올려서, **축을 바닥에 둬도 바닥점이 위아래로 움직였다.**
     → **해결: 모든 `sp-*` 바운스에서 `translateY` 제거 → 바닥 기준 `scaleY`(늘썩)로 대체.** 바닥은 붙어있고 위로만 늘어남.
  - 즉 **회전(`.sbody`)과 스케일(`.sbounce`) 둘 다 origin=바닥(50% 100%)** → 합성해도 바닥점은 절대 안 움직임.
    done 점프(`sp-jump`)만 예외적으로 `translateY`(의도적으로 땅을 뜀).
  - `render()`: `ox = facing===-1 ? 1-cx : cx`, origin=`(ox, cy)`. cx=cy 상수라 `processImage`는 트림만 하고 `{cx:0.5, cy:1}` 반환.
  - 상태별 애니메이션(전부 바닥 고정): 회전(`.sbody`)=walk/work/wait/drag / 스케일(`.sbounce`, scaleY만)=idle·walk·work.
    `sp-walkrot`±5° / `sp-workrot`±3° / `sp-wait`±9° / `sp-drag`±10° / `sp-bounce`·`sp-work`·`sp-idle`=scaleY 늘썩 / `sp-jump`=done 점프(translateY 예외) / fall=scale squash.
  - **⚠️ 실제 펫은 대부분 커스텀 이미지**(사용자 저장 사진/밈, 큰 사이즈)다. 기본 캐릭터로만 검증하면 헛다리 — 반드시 **커스텀 이미지로도** 확인.
  - 진단: **실제 앱에 임시 자가 캡처 코드**(main.js에 `win.webContents.capturePage()` → PNG 저장; 화면 녹화 권한 불필요)를 넣어
    실제 렌더를 찍는 게 가장 확실. 프레임들을 `magick -evaluate-sequence mean`으로 겹치면 **고정점=선명, 움직이는 부분=번짐**으로 축을 눈으로 확인.
    (스텁 preload로 pet.html만 로드하는 인라인 하니스도 있으나 커스텀 이미지·환경에 따라 불안정했음. 커밋 전 디버그 코드 제거 필수.)
    ~~인라인 하니스 정지 캡처, 회전축 비교 데모~~ 도 썼으나 결국 실제 앱 자가 캡처가 결정타.
  - flip은 `localStorage['spetFlip:'+key]`에 key(cwd)별 저장 → 재시작 유지
- **메인펫도 동일 원리 적용됨** (`#sprite`, origin 이미 `50% 100%`): 대부분 keyframe은 이미 `scaleY`만 썼고,
  유일하게 `walkbob`이 `translateY(-9px)`라 걸을 때 바닥이 떠서 → **`translateY` 제거 + 바닥 기준 `rotate+scaleY`로 교체**.
  전단 왜곡 방지 위해 `transform: rotate(...) scaleY(...) scaleX(...)` 순서(회전을 왼쪽=마지막 적용). worky/sleepy와 동일 규칙.
- **기본 세션펫 캐릭터(`SPET_ICON`/`defaultSpetIcon`)**: 클로드 선버스트 대신 오른쪽 보는 작은 생물 SVG
  (클로드 오렌지+노란 부리). 회전축이 바닥중앙이라 어떤 캐릭터/커스텀 이미지든 바닥 딛고 갸우뚱
- **주의**: 세션펫에 저장된 커스텀 이미지(`~/Library/Application Support/claude-session-pets/session-images/<sha1(cwd)>.png`)가
  있으면 기본 캐릭터 대신 그게 뜬다. 기본 캐릭터 확인은 우클릭 → "기본 모습으로"
- **우클릭 이미지 설정 메뉴(`showMenu`)**: 세션펫 우클릭 시 컨텍스트 메뉴 (`.spet-menu`, body 직속, 화면당 1개).
  항목: 창 앞으로 가져오기(기존 우클릭 동작 흡수) / 이미지 변경… / 좌우 반전(토글) / 기본 모습으로(`deleteSessionImage`+CLAUDE_ICON 복귀).
  바깥 클릭 시 닫힘(캡처 단계 mousedown), farewell 시 `closeSpetMenu()`. 더블클릭(이미지 변경)·드롭(이미지 지정)은 그대로 유지

## 세션 폼 (docs/form) — 입력 필요 항목을 펫이 폼으로 띄우고, 답을 세션에 되돌림

`/session-form on` 한 번 치면 그 세션은 "폼 모드"가 된다. 이후 클로드가 사용자 확인/선택/입력이 필요할 때(리뷰 결과 승인, 방안 선택 등)
인라인으로 묻지 않고 **`<cwd>/docs/form/<타임스탬프>-<슬러그>.json`** 에 폼 스펙을 쓰고 턴을 종료한다. 앱이 이를 감지해
해당 **세션펫에 📋 말풍선** → 클릭하면 **폼 창** → 채워서 [전송]하면 **`claude -p -r <session_id>`로 그 세션을 헤드리스로 이어간다**.
(사용자 터미널이 Warp라 tty 주입이 안 돼서 **헤드리스 resume 방식** 채택. iTerm2/Terminal의 `send-to-tty`와는 별개.)

### 데이터 흐름 / 조각
- **토글**: `~/.claude/commands/session-form.md`(앱이 설치). `/session-form on|off|(빈=토글)` → 마커 `~/.claude/session-pets-formmode/<enc(cwd)>` 생성/삭제.
  `enc` = 비영숫자→`-`. 명령은 **`pwd -P`**(realpath)로 인코딩(아래 gotcha 참조).
- **주입**: `HELPER_SRC`(상태 훅)의 UserPromptSubmit 처리에서, 마커가 있으면 폼 워크플로 지시(`FORM_INSTR`, 스키마 포함)를 컨텍스트로 주입.
- **감지**: 각 `SessionPet`이 2초마다 `window.pet.listForms(cwd)` → `<cwd>/docs/form/*.json`(미처리) 목록. 있으면 `pendingForm` + 📋 sticky 말풍선.
- **표시/제출**: 클릭 → `open-form` IPC가 JSON을 **앱이 HTML로 렌더**(`renderFormHtml`, 내용은 escape → XSS 안전)해 `docs/form/<id>.html`로 저장 후 폼 창 로드.
  [전송] → `submit-form` IPC가 `formatAnswers`로 프롬프트를 만들고 `claude -p -r <sid>` 실행, 출력 스트리밍, 완료 시 `docs/form/done/`으로 이동(+`.answer.json`).
- 이어갈 세션은 `listSessionsForCwd(cwd)[0]`(mtime 최신) 사용.

### 폼 JSON 스키마
```json
{ "title": "...", "intro": "...",
  "items": [ { "id": "kebab-id", "kind": "issue|question", "heading": "...", "detail": "...",
    "proposal": "제안(선택)",
    "input": { "type": "approve|text|textarea|select|radio|checkbox",
               "label": "...", "options": ["..."], "placeholder": "...", "default": "..." } } ] }
```
`approve`는 승인/거절/수정요청 라디오로 렌더. `options`는 select/radio/checkbox에만.

### ⚠️ Gotcha (실측으로 확인한 것들)
- **UserPromptSubmit 훅은 plain stdout이 컨텍스트에 안 들어간다.** 반드시 **JSON `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`** 형식으로 출력해야 주입됨. (카나리 테스트로 확인: plain=실패, JSON=성공)
- **cwd realpath 문제**: 클로드가 훅에 넘기는 `cwd`는 realpath일 수 있다(`/tmp`→`/private/var/...`, 심링크). 마커 생성은 `pwd -P`, 훅 확인은 **원본·realpath 두 인코딩 모두** 체크.
- **`claude -p`(헤드리스)에서도 UserPromptSubmit 훅은 발화**한다(확인함). 그래서 resume 실행도 훅을 탄다.
- 검증: 폼 모드 ON + "사용자만 아는 정보가 필요한" 프롬프트로 `claude -p` → `docs/form/*.json`이 스키마대로 생성되는지 확인. 렌더는 임시로 폼 창을 `capturePage`.
- `docs/form/`은 런타임 산출물이라 `.gitignore` 처리됨.

## 패키징 (.app)

사용자는 `/Applications/Claude Session Pets.app`으로 실행한다 (독에 등록). **코드 수정 후 반드시 재패키징**:

**빠른 방법: `./build-app.sh`** — 아래 전 과정(빌드→아이콘 교체→ad-hoc 재서명→구버전 휴지통 이동→설치→실행)을
자동화한 스크립트. 옵션: `--no-open`(설치까지만), `--build`(dist/에 빌드만). 아래 수동 절차는 스크립트가 하는 일의 원본이다:

```bash
npx electron-packager . "Claude Session Pets" --platform=darwin --arch=arm64 --out=dist --overwrite \
  --ignore="^/dist" --ignore="^/build" --ignore="^/start.sh"
# electron-packager --icon이 적용 안 되는 버그가 있어 직접 교체:
cp build/icon.icns "dist/Claude Session Pets-darwin-arm64/Claude Session Pets.app/Contents/Resources/electron.icns"
# ★ ad-hoc 재서명 (필수) — icns 교체 등으로 번들 seal이 깨지면 다른 맥에서 "손상됨"으로 실행 불가.
#   packager 기본 서명은 linker-signed(Sealed Resources=none)라 깨진 상태 → 아래로 제대로 서명.
codesign --remove-signature "dist/Claude Session Pets-darwin-arm64/Claude Session Pets.app" 2>/dev/null
codesign --force --deep --sign - "dist/Claude Session Pets-darwin-arm64/Claude Session Pets.app"
codesign --verify --deep --strict "dist/Claude Session Pets-darwin-arm64/Claude Session Pets.app"  # 통과해야 함
osascript -e 'quit app "Claude Session Pets"'
mv "/Applications/Claude Session Pets.app" ~/.Trash/"Claude Session Pets-old-$(date +%s).app"
cp -R "dist/Claude Session Pets-darwin-arm64/Claude Session Pets.app" /Applications/
open "/Applications/Claude Session Pets.app"
```

### 다른 맥으로 배포 (서명 없이 Gatekeeper 우회)
- 앱은 개발자 인증서로 정식 서명/공증되지 않았다. ad-hoc 서명만으론 전송 시 **quarantine**이 붙어 Gatekeeper가 막는다.
- 전송용 압축은 **서명 보존을 위해 `ditto`** 로: `ditto -c -k --keepParent "<app>" ~/Desktop/"Claude Session Pets.zip"`
- **받는 맥에서**: 압축 풀어 `/Applications`에 넣은 뒤 격리 속성 제거 → 실행:
  `xattr -dr com.apple.quarantine "/Applications/Claude Session Pets.app"` (그 후 우클릭 → 열기).
  · 서명이 깨진 채 전송하면 "**손상되어 열 수 없습니다**"(휴지통 이동 요구)로 뜬다 → 반드시 위 ad-hoc 서명 후 전송.
  · 서명이 정상이면 최악의 경우 "확인되지 않은 개발자" 정도라 우클릭 열기로 통과.

주의:
- 이 환경은 조직 정책으로 `rm -rf`가 차단됨 → 삭제는 `mv ~/.Trash/`로
- 앱은 `app.dock.hide()`를 호출하므로 실행 중 독에 아이콘이 안 보임 (독 등록은 Finder에서 드래그)
- `start.sh`(개발용)와 .app을 동시에 실행하면 펫이 두 마리 뜸 (중복 방지는 개발용 경로만 검사)
- 아이콘 재생성: 어른새 SVG(=pet.js `defaultSprite`)를 스쿼클 배경 HTML에 얹어 Electron `capturePage`로 1024 PNG → `sips`로 iconset 크기별 생성 → `iconutil -c icns`

## 개발 내역 (2026-07)

1. **작업중 말풍선 유지** — 작업 중(working) 세션펫은 클릭/드래그/우클릭/더블클릭에도 "작업 중" 말풍선이 사라지지 않게 (`working` 플래그 + `restoreBubble()`)
2. **세션펫 중력 낙하** — 드래그 후 놓으면 메인펫처럼 `fall` 상태로 스무스하게 낙하 (+ 낙하 중 상태 폴링 간섭 방지)
3. **.app 패키징** — `@electron/packager`(devDependency)로 로컬 빌드, `/Applications` 설치, 앱 아이콘
4. **현재 작업 내용 말풍선** — PreToolUse 훅 추가로 "🏃 작업 중…" 대신 "🏃 check-hello.txt 수정 중"처럼 실제 작업을 표시, 도구 호출마다 갱신
5. **말풍선 줄바꿈** — 긴 작업 내용은 "…"로 자르지 않고 여러 줄로 표시 (max-width 250px)
6. **입력필요 → 작업중 미전환 수정** — 권한 승인/질문 답변에는 훅 이벤트가 없어 "입력 필요"가 계속 남던 문제.
   `HOOK_EVENTS`에 PostToolUse→working 추가로 도구 종료 시점에 복귀 (검증: sleep 도구 실행 도중 상태 파일에
   waiting 주입 → 도구 종료 시각에 working 복귀 확인)
7. **작업완료가 입력필요로 바뀌는 문제 수정** — 턴 종료 60초 후 Claude Code의 유휴 알림(Notification)이
   idle을 waiting으로 덮어쓰던 문제 (트랜스크립트 turn_duration과 상태 파일 ts가 정확히 60초 차이로 확증).
   훅 스크립트에 waiting 가드 추가 — 직전 상태가 working/waiting일 때만 waiting 기록
8. **언더스코어 경로에서 "작업 중…" 고착 수정** — `deriveTranscriptState`의 cwd 인코딩이 `/`와 `.`만
   치환해서 `my_project` 같은 경로는 프로젝트 디렉토리를 못 찾음 → sessionId 없음 → 훅 매칭 실패 →
   CPU 폴백이 유휴 프로세스의 미세한 CPU 증가를 작업으로 오판. 비영숫자 전부 `-` 치환으로 수정
9. **전체 코드 리뷰 반영 (버그 일괄 수정)** — 서브에이전트 2대로 main.js/pet.js 정밀 리뷰 후 수정:
   - **XSS→명령실행 차단**: `renderProcs`/`runPrompt`가 외부 cwd·프롬프트를 innerHTML에 넣던 것을 DOM API(textContent)로
   - **유령 펫 방지**: `destroy()`는 `sessionPets.get(pid)===this`일 때만 삭제 + IPC 조회 실패 시 이전 목록 유지(전 펫 farewell 방지)
   - **settings.json 보호**: 파싱 실패 시 설치 중단(throw), 백업(.session-pets-backup)은 설치 전 원본만(재설치해도 덮지 않음), 원자적 교체(tmp→rename)
   - **동일 cwd 다중 세션**: `listSessionsForCwd`로 세션을 mtime 내림차순 나열, cwd별 프로세스(pid순)에 1:1 배정
     (claude가 jsonl을 상시 안 열어 lsof 정확매칭 불가 → 휴리스틱, 프로세스>세션이면 남는 건 CPU 폴백)
   - **훅 스크립트**: 상태 파일 원자적 쓰기(tmp+os.replace, 병렬 도구호출 동시성), SessionStart는 source가 startup/resume일 때만
     기록(auto-compact/clear 시 작업중 상태 보존), waiting 시 직전 task 유지
   - **프로세스 필터**: 제외/판정을 실행파일 경로(first token)로만 → 프롬프트에 든 단어로 인한 오탐/미탐 제거, claude 판정에 경계 추가(claude-monitor류 오탐 방지)
   - **트랜스크립트**: user 프롬프트 content가 문자열인 경우도 midturn 인식(훅 미설치 세션의 "작업 시작 직후" 감지)
   - **완료 디바운스**: 폴링 횟수(calm)가 아닌 벽시계 시간(`DONE_DEBOUNCE_MS`) 기준 → 패널 열기·새로고침이 가짜 완료를 유발하던 문제 제거
   - **앱 시작 CPU 폴백 오탐**: 신규 tracked의 `lastAdvance=0`으로 첫 폴링은 baseline만 → 켜자마자 가짜 "작업 완료!" 방지
   - 기타: `--`로 claude 인자 구분(대시 프롬프트), osascript timeout, 잡담 자식 종료 정리, 오래된 상태파일 청소, processImage 예외 폴백, 메인펫 착지 X 클램프
10. **세션펫+메인펫 "바닥점이 위아래로 움직임/우하단 쏠림" 최종 해결 (2026-07)** — 여러 세션 헤맴. 상세는 위 "세션 펫 상태머신 ⭐" 절 참조.
    핵심: 원인이 **두 가지**였는데 오래 ①만 붙들다 ②를 놓쳤다.
    ① 회전축 위치 — 축이 바닥이 아니라 픽셀 무게중심(비대칭이라 미러 시 좌우로 튐)이었음 → **`cx=0.5, cy=1`(바닥중앙) 고정**.
    ② **바운스 `translateY`** (결정타) — walk/work/idle이 `translateY`로 캐릭터를 통째로 들어올려 축을 바닥에 둬도 바닥점이 위아래로 움직였음
       → **모든 `sp-*`/`walkbob`에서 `translateY` 제거, 바닥 기준 `scaleY`로 대체**(done 점프만 예외). 회전·스케일 둘 다 origin=바닥.
    메인펫도 동일(원래 `walkbob`만 `translateY`였음). 검증: **실제 앱 자가 capturePage** + `magick mean` 합성(고정점=선명)으로 커스텀 이미지에서 바닥 고정 확인.
    교훈: ① 시각 버그는 **실제 앱 자가 캡처**(화면녹화 권한 불필요)가 결정타 — 인라인 하니스/기본 캐릭터만으론 헛다리(실제 펫은 커스텀 이미지).
    ② "축"만 의심하지 말 것 — **`translateY` 바운스가 축과 무관하게 대상을 움직인다.**

## 테스트 방법

세션펫 동작 확인은 스크래치 디렉토리에서 데모 세션을 백그라운드로 띄운다:

```bash
claude -p --permission-mode acceptEdits "1) a.txt 작성 2) 읽기 3) 요약을 b.txt에 작성" &
```

훅 기록 확인: `cat ~/.claude/session-pets-status/*.json` (작업 단계마다 task가 바뀌는지),
훅 스크립트 단위 테스트: PreToolUse 페이로드 JSON을 stdin으로 넣어 직접 실행.
