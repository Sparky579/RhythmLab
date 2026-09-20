#!/usr/bin/env bash
# 把当前目录同步到线上目录（music.pekka.ren 由 pekka-music.service 从该目录提供静态文件）
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/home/chengsizhe/services/pekka/apps/music"
mkdir -p "$DEST"
rsync -a --delete --exclude '.git' --exclude 'deploy.sh' --exclude 'android' --exclude '/*.md' "$SRC/" "$DEST/"
echo "deployed to $DEST -> https://music.pekka.ren"
