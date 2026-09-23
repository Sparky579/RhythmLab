#!/usr/bin/env bash
# 把当前目录同步到线上目录（music.pekka.ren 由 pekka-music.service 从该目录提供静态文件）
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
# 线上目录，可用环境变量覆盖：MUSIC_DEST=/path/to/webroot ./deploy.sh
DEST="${MUSIC_DEST:-$HOME/services/pekka/apps/music}"
mkdir -p "$DEST"
# 带版本号的旧 APK 不删：缓存里的旧页面还指着它们，删了下载按钮就 404
rsync -a --delete --exclude '.git' --exclude 'deploy.sh' --exclude 'android' --exclude '/*.md' \
  --exclude '__t' --exclude '/RhythmLab-v*.apk' "$SRC/" "$DEST/"
# APK 再放一份带版本号的文件名：下载器/CDN 就算缓存也命不中新 URL
V="$(grep -o "WANT = '[0-9]*'" "$SRC/index.html" | grep -o '[0-9]*' || true)"
if [ -n "${V:-}" ] && [ -f "$DEST/RhythmLab.apk" ]; then
  cp "$DEST/RhythmLab.apk" "$DEST/RhythmLab-v$V.apk"
  # 下载按钮的链接跟着版本号走，别再靠手改（手改漏过一次：链接停在 v49，文件却被删了）
  sed -i -E "s#RhythmLab(-v[0-9]+)?\.apk\" download#RhythmLab-v$V.apk\" download#" "$DEST/index.html"
  grep -q "RhythmLab-v$V.apk\" download" "$DEST/index.html" || { echo "下载链接没改成 v$V" >&2; exit 1; }
  curl -sfI "https://music.pekka.ren/RhythmLab-v$V.apk" >/dev/null || echo "警告：线上取不到 RhythmLab-v$V.apk" >&2
  echo "apk: https://music.pekka.ren/RhythmLab-v$V.apk"
fi
echo "deployed to $DEST -> https://music.pekka.ren"
