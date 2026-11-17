#!/bin/bash
cd "$(dirname "$0")" || exit 1

echo
echo "  正音 —— 停止"
echo "  ────────────────────────────────"
echo

status=0
if command -v node >/dev/null 2>&1; then
  node scripts/stop.mjs
  status=$?
  case "$status" in
    0) echo "  已经停了。" ;;
    2) echo "  没找到正在运行的正音。"; status=0 ;;
  esac
else
  echo "  没找到 Node.js。请到启动窗口按 Ctrl+C 停止正音。"
  status=1
fi
echo
read -n 1 -s -r -p "  按任意键关闭这个窗口。"
echo
exit "$status"
