#!/usr/bin/env bash
# 不依赖 gradle 打 APK：aapt 打包资源 -> javac 编译 -> dx 转 dex -> zipalign -> apksigner 签名
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE="$(cd "$HERE/.." && pwd)"
SDK="${ANDROID_SDK:-/usr/lib/android-sdk}"
BT="$SDK/build-tools/debian"
AJ="$SDK/platforms/android-23/android.jar"
OUT="$HERE/build"
KS="$HERE/keystore.jks"
PASS="${APK_PASS:-rhythmlab}"

rm -rf "$OUT"; mkdir -p "$OUT/classes" "$OUT/assets/www"

echo "[1/6] 复制站点到 assets"
rsync -a --delete \
  --exclude 'android' --exclude '.git' --exclude 'deploy.sh' --exclude 'serve.py' \
  --exclude '/*.md' --exclude '*.apk' --exclude 'sw.js' --exclude 'manifest.webmanifest' \
  "$SITE/" "$OUT/assets/www/"
du -sh "$OUT/assets/www" | sed 's/^/      /'

echo "[2/6] 编译 Java"
javac --release 8 -nowarn -classpath "$AJ" -d "$OUT/classes" \
  $(find "$HERE/src" -name '*.java')

echo "[3/6] 转 dex"
"$BT/dx" --dex --output="$OUT/classes.dex" "$OUT/classes"

echo "[4/6] 打包资源与 assets"
"$BT/aapt" package -f -M "$HERE/AndroidManifest.xml" -S "$HERE/res" -A "$OUT/assets" \
  -I "$AJ" -F "$OUT/app.unsigned.apk"
( cd "$OUT" && "$BT/aapt" add -f app.unsigned.apk classes.dex >/dev/null )

echo "[5/6] 对齐"
"$BT/zipalign" -f 4 "$OUT/app.unsigned.apk" "$OUT/app.aligned.apk"

echo "[6/6] 签名"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" \
    -alias rhythmlab -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=RhythmLab, O=Personal" >/dev/null 2>&1
  echo "      已生成签名密钥 keystore.jks（口令 $PASS）"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --out "$HERE/RhythmLab.apk" "$OUT/app.aligned.apk"
"$BT/apksigner" verify "$HERE/RhythmLab.apk" >/dev/null && echo "      签名校验通过"

ls -la "$HERE/RhythmLab.apk"
echo "完成：$HERE/RhythmLab.apk"
