#!/bin/bash
# Claude Session Pets — .app 빌드 & /Applications 설치 스크립트
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

APP_NAME="Claude Session Pets"
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
npx electron-packager . "$APP_NAME" \
  --platform=darwin --arch="$ARCH" \
  --out="$OUT_DIR" --overwrite \
  --ignore="^/dist" --ignore="^/build" --ignore="^/start.sh" --ignore="^/build-app.sh"

# electron-packager --icon이 적용 안 되는 버그가 있어 icns를 직접 교체
echo "🎨 [2/4] 앱 아이콘 교체…"
cp build/icon.icns "$BUILT_APP/Contents/Resources/electron.icns"

# icns 교체 등으로 번들 seal이 깨지므로 ad-hoc 재서명 (없으면 다른 맥에서 "손상됨")
echo "✍️  [3/4] ad-hoc 재서명…"
codesign --remove-signature "$BUILT_APP" 2>/dev/null || true
codesign --force --deep --sign - "$BUILT_APP"
codesign --verify --deep --strict "$BUILT_APP"
echo "   서명 검증 통과 ✓"

if [ "$DO_INSTALL" -eq 0 ]; then
  echo "✅ 빌드 완료: $BUILT_APP"
  exit 0
fi

echo "📥 [4/4] /Applications 설치…"
# 실행 중이면 종료
osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true

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
