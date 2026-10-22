#!/data/data/com.termux/files/usr/bin/sh
# 在 Termux 中执行：sh start-android.sh
set -eu
cd -- "$(dirname -- "$0")"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先在 Termux 中执行：pkg install nodejs-lts'
  exit 1
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock >/dev/null 2>&1 || true' 0
fi

printf '%s\n' '保持 Termux 在后台运行，切到浏览器打开下方本机（平板）地址。'
printf '%s\n' '结束时回到 Termux 按 Ctrl+C，当前对局会保存。'
node server.js "$@"
