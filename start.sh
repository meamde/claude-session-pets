#!/bin/bash
# Claude Session Pets 실행 스크립트
set -e
cd "$(dirname "$0")"

# 최초 실행 시 의존성 설치
if [ ! -d node_modules ]; then
  echo "📦 의존성 설치 중…"
  npm install
fi

# 이미 떠 있으면 중복 실행 방지 (설치 폴더 이름과 무관하게 이 디렉토리의 electron만 검사)
if pgrep -f "$(pwd)/node_modules/electron" > /dev/null; then
  echo "🐦 펫이 이미 실행 중입니다. (종료: 펫 클릭 → 설정 → 앱 종료)"
  exit 0
fi

echo "🐦 펫을 깨우는 중…"
nohup npx electron . > /tmp/claude-session-pets.log 2>&1 &
disown
echo "완료! 로그: /tmp/claude-session-pets.log"
