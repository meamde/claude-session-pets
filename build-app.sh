#!/bin/bash
# Hoo — .app 빌드 & /Applications 설치 스크립트
#
# electron-packager로 .app을 만들고, 아이콘 교체 → ad-hoc 재서명 → /Applications 설치까지 한 번에.
# (CLAUDE.md "패키징" 절차를 그대로 자동화)
#
# 사용법:
#   ./build-app.sh            # 빌드 후 /Applications에 설치하고 실행
#   ./build-app.sh --no-open  # 설치까지만 (실행 안 함)
#   ./build-app.sh --build    # dist/에 빌드만 (설치 안 함)
set -e
cd "$(dirname "$0")"

APP_NAME="Hoo"
BUNDLE_ID_FIXED="com.meamde.hoo" # ⚠️ 고정: 패키저 기본값은 표시 이름에서 만들어진다. 식별자를 바꾸면 macOS가 다른 앱으로 보고 손쉬운 사용 권한을 다시 요구한다 (구 com.electron.claude-session-pets)
OLD_APP_NAMES=("Claude Session Pets") # 이전 표시 이름 — 설치 시 끄고 휴지통으로 (번들 식별자는 같아 권한·설정 유지)
ARCH="arm64"                       # Apple Silicon 전용
OUT_DIR="dist"
BUILT_APP="$OUT_DIR/$APP_NAME-darwin-$ARCH/$APP_NAME.app"
INSTALLED_APP="/Applications/$APP_NAME.app"

DO_INSTALL=1
DO_OPEN=1
case "${1:-}" in
  --build)   DO_INSTALL=0; DO_OPEN=0 ;;
  --no-open) DO_OPEN=0 ;;
  "" )       ;;
  * ) echo "알 수 없는 옵션: $1"; echo "사용법: ./build-app.sh [--no-open|--build]"; exit 1 ;;
esac

# 의존성 확인
if [ ! -d node_modules ]; then
  echo "📦 의존성 설치 중…"
  npm install
fi

echo "🔨 [1/4] electron-packager로 .app 빌드 중…"
npx electron-packager . "$APP_NAME" --app-bundle-id="$BUNDLE_ID_FIXED" \
  --platform=darwin --arch="$ARCH" \
  --out="$OUT_DIR" --overwrite \
  --ignore="^/dist" --ignore="^/build" --ignore="^/start.sh" --ignore="^/build-app.sh" --ignore="^/test" --ignore="^/docs" --ignore="^/scripts" --ignore="^/AGENTS.md" --ignore="^/pet\.html$" --ignore="^/pet\.js$" --ignore="^/\.[^/]*($|/)" --ignore="\.DS_Store$" --ignore="\.log$" --ignore="__pycache__"

# electron-packager --icon이 적용 안 되는 버그가 있어 icns를 직접 교체
echo "🎨 [2/4] 앱 아이콘 교체…"
cp build/icon.icns "$BUILT_APP/Contents/Resources/electron.icns"

# icns 교체 등으로 번들 seal이 깨지므로 ad-hoc 재서명 (없으면 다른 맥에서 "손상됨")
echo "✍️  [3/4] ad-hoc 재서명…"
codesign --remove-signature "$BUILT_APP" 2>/dev/null || true
# 서명 신원: 로컬 개발 인증서가 있으면 그것(권한 유지), 없으면 ad-hoc.
#   ad-hoc은 지정 요구사항이 cdhash라 빌드마다 바뀌어 손쉬운 사용·자동화 권한이 매번 풀린다 → scripts/make-signing-cert.sh 로 생성 권장
SIGN_ID="${SIGN_ID:-Claude Session Pets Dev}" # 인증서 이름은 옛 이름 유지(이미 만든 인증서와 맞춤)
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_ID"; then
  echo "   서명 신원: $SIGN_ID (권한 유지)"
  codesign --force --deep --sign "$SIGN_ID" "$BUILT_APP"
else
  # ad-hoc이라도 바깥 번들의 '지정 요구사항'을 cdhash 대신 번들 식별자로 고정하면 macOS TCC(손쉬운 사용·자동화)가
  # 재빌드 후에도 같은 앱으로 인식해 권한이 유지된다. 내부 코드(프레임워크·헬퍼)는 식별자가 달라 요구사항을 못 붙이므로
  # ① 전체를 deep ad-hoc 서명 → ② 바깥 번들만 식별자 요구사항으로 다시 서명 (deep 없이).
  BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$BUILT_APP/Contents/Info.plist")
  echo "   서명 신원: ad-hoc + 지정 요구사항 identifier \"$BUNDLE_ID\" (권한 유지)"
  codesign --force --deep --sign - "$BUILT_APP"
  codesign --force --sign - --requirements "=designated => identifier \"$BUNDLE_ID\"" "$BUILT_APP"
fi
codesign --verify --deep --strict "$BUILT_APP"
echo "   서명 검증 통과 ✓"

# ★ 유출 검사 (공개 배포물) — 앱 코드에 내 홈 경로·사용자명·git 이메일이 들어가면 중단.
#   (v1.0.0~v1.2.3 zip에 로컬 .claude/settings.local.json이 섞여 사내 경로가 공개된 사고 재발 방지.
#    검사어는 실행 시 계산 → 저장소에 회사명을 적지 않는다. Electron 실행 파일 등 외부 바이너리는 제외)
LEAKS=$(grep -rlaF -e "$HOME/" -e "$(whoami)" "$BUILT_APP/Contents/Resources/app" 2>/dev/null | grep -v "/node_modules/" || true)
if [ -n "$LEAKS" ]; then
  echo "❌ 유출 의심 파일이 앱에 들어 있습니다 (홈 경로/사용자명):"; echo "$LEAKS" | sed 's/^/   /'; exit 1
fi
echo "   유출 검사 통과 ✓"

if [ "$DO_INSTALL" -eq 0 ]; then
  echo "✅ 빌드 완료: $BUILT_APP"
  exit 0
fi

echo "📥 [4/4] /Applications 설치…"
# 실행 중이면 종료
for n in "${OLD_APP_NAMES[@]}"; do
  osascript -e "quit app \"$n\"" 2>/dev/null || true
  for _ in $(seq 1 25); do pgrep -f "$n.app/Contents/MacOS/$n\$" >/dev/null || break; sleep 0.2; done
  pgrep -f "$n.app/Contents/MacOS/$n\$" >/dev/null && { pkill -f "$n.app/Contents/MacOS/$n\$" || true; sleep 1; }
  if [ -d "/Applications/$n.app" ]; then echo "   이전 이름의 앱을 휴지통으로 이동: $n.app"; mv "/Applications/$n.app" "$HOME/.Trash/$n-old-$(date +%s).app"; fi
done
osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true
# 완전히 끝날 때까지 기다린다. 옛 앱이 아직 살아 있을 때 open하면 macOS가 새 앱을 띄우지 않고 옛 앱만 앞으로 가져오고,
# 그 옛 앱이 마저 종료되면 펫이 하나도 안 남는다(실측).
APP_BIN_PAT="$APP_NAME.app/Contents/MacOS/$APP_NAME\$"
for _ in $(seq 1 50); do pgrep -f "$APP_BIN_PAT" >/dev/null || break; sleep 0.2; done
if pgrep -f "$APP_BIN_PAT" >/dev/null; then pkill -f "$APP_BIN_PAT" || true; sleep 1; fi

# 구버전은 조직 정책상 rm -rf 불가 → 휴지통으로 이동
if [ -d "$INSTALLED_APP" ]; then
  TRASHED="$HOME/.Trash/$APP_NAME-old-$(date +%s).app"
  echo "   기존 앱을 휴지통으로 이동: $TRASHED"
  mv "$INSTALLED_APP" "$TRASHED"
fi

cp -R "$BUILT_APP" /Applications/
echo "✅ 설치 완료: $INSTALLED_APP"

if [ "$DO_OPEN" -eq 1 ]; then
  open "$INSTALLED_APP"
  echo "🐦 실행했습니다."
fi
