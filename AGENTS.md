# AGENTS.md — Codex 에이전트용 안내

이 저장소의 개발 가이드는 **[`CLAUDE.md`](CLAUDE.md)** 하나로 관리한다. Codex로 작업할 때도 그 문서를 그대로 따를 것
(파일 구조 · 상태 감지 우선순위 · 세션펫 상태머신 · 폼 · 패키징 · 공개 저장소 유출 금지 규칙 전부 포함).

Codex 연동 코드에 한해 추가로 알아둘 것:

- `lib/codex.js` — Codex CLI 프로세스/세션 기록 매칭, App Server RPC(`codex app-server --stdio`), `codex queue`/`codex exec`, 사용량 조회.
- `lib/codex-ipc.js` — Codex **데스크톱 앱** 로컬 IPC 호환 계층(내부 인터페이스, 스트림 버전 11 기준). 알 수 없는 버전은 처리하지 않는다. Codex 업데이트 시 재검증.
- `lib/codex-hooks.js` + `lib/codex-hook.py` — `~/.codex/hooks.json`(또는 `$CODEX_HOME`)에 훅 병합 / 훅 스크립트 **원본**. 설치된 스크립트 파일은 생성물이므로 직접 고치지 말고 원본을 수정.
- Codex 폼 모드 마커·폼 저장 위치는 프로젝트의 `.session-pets/`(gitignore됨). Claude 쪽 폼은 `~/Library/claude-session-pets-forms/`로 서로 다르다.
- 기본 캐릭터(도트 부엉이)는 `sprites.js`가 캔버스에 그린다 — 이미지 파일이 아니다. 캐릭터를 고칠 땐 그 파일의 프레임 함수(`CHICK`/`MOTHER`)를 수정하고 `npx electron test/screenshots.cjs`로 렌더를 확인. 상세는 CLAUDE.md '세션 펫 상태머신' 절.
- 테스트: `npm test`(단위·폼) · `npm run test:ui`(Electron 렌더) · `npm run test:live`(실행 중 Codex 세션 읽기 전용). 스크린샷은 `npx electron test/screenshots.cjs`.
