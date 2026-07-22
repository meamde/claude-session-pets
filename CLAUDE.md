# CLAUDE.md — Claude Session Pets 개발 가이드

macOS 데스크탑 펫(Electron). 실행 중인 Claude CLI 세션들을 감시해 세션마다 작은 펫을 띄우고,
작업 상태·현재 작업 내용을 말풍선으로 보여준다. 기능 개요는 README.md 참고.

## 파일 구조

- `main.js` — Electron 메인. 프로세스 감시(ps/lsof), 상태 훅 설치/업그레이드, 트랜스크립트 판독, tty 명령 주입, `claude -p` 실행
- `pet.js` — 렌더러. 메인펫/세션펫 상태머신, 말풍선, 패널 UI, 이미지 배경제거
- `pet.html` — 마크업 + 전체 CSS (별도 CSS 파일 없음)
- `preload.js` — IPC 브리지
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
  - `.sbody` (inline-block, **이미지 크기**로 shrink) — **회전(rotate)만**. origin=**이미지 정중앙(`50% 50%`)** → 제자리에서 좌우로 갸웃(메트로놈).
    ~~`.swrap`(고정 66박스)에 걸면 피봇이 박스 기준이라 우하단으로 어긋난다~~ (겪은 버그)
  - `.ssprite` img (`max 66px`, `origin:50% 50%`) — **반전 scaleX만**(`render()`가 `spriteEl`에 설정). 회전과 별개라 각도가 안 뒤집힘
  - **애니메이션 3레이어 (계층 순서가 핵심)**: `.swrap`(레이아웃) > `.sbody`(**회전**) > `.sbounce`(**위치·스케일**) > img.
    ← 우하단 회전축의 최종 원인/해결. **회전을 바깥, 바운스를 안쪽**에 둬야 회전축(`.sbody` origin)이 고정된다.
    바운스(translateY)를 회전의 **부모/같은 요소**에 두면 회전축이 바운스와 함께 위아래로 움직여(=고정 안 됨)
    회전이 진자처럼 이상해지고 우하단으로 쏠려 보인다. 오래 헤맨 끝에 capturePage 프레임 캡처로 "축이 안 고정됨"을 확인.
  - 상태별: 회전(`.sbody`)=walk/work/wait/drag / 위치·스케일(`.sbounce`)=idle 뽀용·walk 바운스·work 들썩·done 점프·fall squash.
    상태별: idle=`.swrap` 뽀용(`sp-idle`, 회전 없음) / walk=`.sbody` 좌우(`sp-walkrot`)+`.swrap` 바운스(`sp-bounce`) /
    work=미세 회전+들썩 / wait=`.sbody` 갸웃 / done=`.swrap` 점프(`sp-jump`) / drag=`.sbody` 흔들 / fall=`.swrap` squash.
    세션펫 전용 `sp-*` keyframe (메인펫은 상단 breathe/walkbob/… 공유 keyframe을 계속 씀)
  - **회전축 = 이미지 정중앙 `50% 50%`** (`.sbody` CSS 고정). 제자리에서 좌우 갸웃(메트로놈).
    중앙은 좌우 대칭이라 스프라이트를 미러(scaleX)해도 축이 불변 → render()가 축을 손댈 필요 없음(스프라이트 flip만 설정).
  - ⚠️ **하단중앙(`50% 100%`) / 발 중심(footX) 둘 다 폐기.** 긴 삽질 끝의 결론:
    · `50% 100%`(하단중앙): 기본 캐릭터가 **부리가 오른쪽으로 튀어나온 비대칭**이라, 트림 후 박스 기하중심(50%)이
      실제 발(35.6%)보다 오른쪽으로 치우침 → 걷기 바운스와 겹쳐 **"우하단" 쏠림**.
    · 발 중심(footX, 하단밴드 무게중심): 축은 발에 정확히 갔지만 **±5° 회전에선 50%와의 차이가 눈에 거의 안 보였고**,
      사용자가 원한 건 "발 딛고 갸웃"이 아니라 **제자리 좌우 틸트**였음.
    → **정중앙 `50% 50%`로 확정** (사용자가 회전축 비교 데모에서 직접 선택). footX/미러 로직 전부 제거.
  - 진단은 **Electron `capturePage()` 캡처**로 확정 (화면 녹화 권한 없이 렌더 캡처 → Read로 확인).
    핵심 교훈: **실제 `pet.html`+스텁 preload를 로드해** 실측할 것(스텁으로 세션 프로세스 1개 주입). 특히
    **step 루프(`sp.update`)가 매 프레임 `dir`을 바꿔 render로 미러**시키므로, 정지 캡처 땐 `sp.update=()=>{}`로 고정.
    시각 판단이 갈릴 땐 **회전축 비교 데모(옵션별 live 애니메이션)를 만들어 사용자가 직접 고르게** 하는 게 확실.
  - flip은 `localStorage['spetFlip:'+key]`에 key(cwd)별 저장 → 재시작 유지
  - (메인펫도 애니메이션이 #sprite/flip이 그 부모 구조지만 회전각 문제는 세션펫만 수정함)
- **기본 세션펫 캐릭터(`SPET_ICON`/`defaultSpetIcon`)**: 클로드 선버스트 대신 오른쪽 보는 작은 생물 SVG
  (클로드 오렌지+노란 부리). 회전축이 이미지 정중앙(`50% 50%`)이라 어떤 캐릭터/커스텀 이미지든 균형 있게 갸웃
- **주의**: 세션펫에 저장된 커스텀 이미지(`~/Library/Application Support/claude-session-pets/session-images/<sha1(cwd)>.png`)가
  있으면 기본 캐릭터 대신 그게 뜬다. 기본 캐릭터 확인은 우클릭 → "기본 모습으로"
- **우클릭 이미지 설정 메뉴(`showMenu`)**: 세션펫 우클릭 시 컨텍스트 메뉴 (`.spet-menu`, body 직속, 화면당 1개).
  항목: 창 앞으로 가져오기(기존 우클릭 동작 흡수) / 이미지 변경… / 좌우 반전(토글) / 기본 모습으로(`deleteSessionImage`+CLAUDE_ICON 복귀).
  바깥 클릭 시 닫힘(캡처 단계 mousedown), farewell 시 `closeSpetMenu()`. 더블클릭(이미지 변경)·드롭(이미지 지정)은 그대로 유지

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
10. **세션펫 회전축 "우하단 쏠림" 최종 해결 (정중앙 축)** — 여러 세션에 걸쳐 "고쳤다"고 했으나 계속 재현되던 문제.
    원인 규명: 하단중앙(`50% 100%`) 고정 + 기본 캐릭터의 **비대칭 부리**로 박스중심이 발보다 우측 치우침 → 우하단 쏠림.
    발 중심(footX) 축으로 바꿔 실측 검증까지 했으나(방향별 35.63%↔64.38%로 발 추종) **±5°에선 육안 차이가 미미**했고,
    사용자가 실제로 원한 움직임은 **제자리 좌우 틸트**였음. → **회전축 비교 데모(4종 live 애니메이션)** 를 만들어
    사용자가 **정중앙 `50% 50%`** 를 선택. `.sbody transform-origin:50% 50%` 고정, footX/미러 로직 전부 제거.
    교훈: 시각 버그는 ① 실제 pet.html 로드 캡처(step 루프 `sp.update` 정지 필수)로 실측, ② 판단 갈리면 비교 데모로 사용자가 직접 선택

## 테스트 방법

세션펫 동작 확인은 스크래치 디렉토리에서 데모 세션을 백그라운드로 띄운다:

```bash
claude -p --permission-mode acceptEdits "1) a.txt 작성 2) 읽기 3) 요약을 b.txt에 작성" &
```

훅 기록 확인: `cat ~/.claude/session-pets-status/*.json` (작업 단계마다 task가 바뀌는지),
훅 스크립트 단위 테스트: PreToolUse 페이로드 JSON을 stdin으로 넣어 직접 실행.
