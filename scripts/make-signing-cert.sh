#!/bin/bash
# 로컬 개발용 코드사인 인증서(자체 서명) 생성 → 로그인 키체인에 설치.
# 왜: ad-hoc 서명(codesign -s -)은 지정 요구사항이 cdhash라 재빌드마다 바뀌고, macOS는 손쉬운 사용·자동화 권한을
# 서명 기준으로 기억하므로 빌드할 때마다 권한이 풀린다. 고정 인증서로 서명하면 권한이 유지된다.
# 사용: ./scripts/make-signing-cert.sh   (이후 build-app.sh가 이 이름의 신원을 자동으로 사용)
set -e
NAME="${1:-Claude Session Pets Dev}"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then echo "이미 있음: $NAME"; exit 0; fi
TMP=$(mktemp -d)
cat > "$TMP/ext.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/ext.cnf" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/cert.p12" -passout pass:pets -legacy 2>/dev/null || \
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/cert.p12" -passout pass:pets
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
security import "$TMP/cert.p12" -k "$KEYCHAIN" -P pets -T /usr/bin/codesign -T /usr/bin/security >/dev/null
# 코드사인 용도로 신뢰 (로그인 키체인 — 암호/승인 다이얼로그가 뜰 수 있음)
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"
# codesign이 비대화형으로 키를 쓰도록 허용
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null 2>&1 || true
mv "$TMP" ~/.Trash/ 2>/dev/null || true
security find-identity -v -p codesigning | grep "$NAME" && echo "설치 완료. 이제 ./build-app.sh 가 '$NAME'으로 서명합니다."
