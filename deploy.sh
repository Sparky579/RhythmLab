#!/usr/bin/env bash
# 把当前目录同步到线上目录（music.pekka.ren 由 pekka-music.service 从该目录提供静态文件）
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/home/chengsizhe/services/pekka/apps/music"
mkdir -p "$DEST"
rsync -a --delete --exclude '.git' --exclude 'deploy.sh' --exclude 'android' --exclude '/*.md' "$SRC/" "$DEST/"
# APK 再放一份带版本号的文件名：下载器/CDN 就算缓存也命不中新 URL
V="$(grep -o "WANT = '[0-9]*'" "$SRC/index.html" | grep -o '[0-9]*' || true)"
if [ -n "${V:-}" ] && [ -f "$DEST/RhythmLab.apk" ]; then
  cp "$DEST/RhythmLab.apk" "$DEST/RhythmLab-v$V.apk"
  echo "apk: https://music.pekka.ren/RhythmLab-v$V.apk"
fi
echo "deployed to $DEST -> https://music.pekka.ren"
