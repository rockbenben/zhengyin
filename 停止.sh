#!/bin/bash
# Linux。**这个文件不一定能双击** —— 跟 启动.sh 同一个问题：多数桌面环境默认用编辑器
# 打开 .sh。右键找「以程序运行」，或者终端里 ./停止.sh。
#
# 平时用不到——关掉启动那个终端窗口就会连带停掉整棵进程树。
# 这个是给"窗口找不着了"或者"关窗口时留下了孤儿进程"用的。
#
# 按**端口**找进程，不按程序名找：杀掉所有 node 会顺手带走编辑器、别的开发服务器，
# 以及任何基于 node 的东西。这两个端口只属于本应用（30031 主服务，30032 音素识别）。

echo
echo "  正音 —— 停止"
echo "  ────────────────────────────────"
echo

found=0
for port in 30031 30032; do
  # lsof 不一定装了，用 ss 兜底（iproute2 基本都有）
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)
  else
    pids=$(ss -lptnH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  fi
  for pid in $pids; do
    echo "  端口 $port  →  停掉 PID $pid"
    # 先礼后兵：TERM 让它自己收尾，还在就 KILL
    kill "$pid" 2>/dev/null
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    found=1
  done
done

echo
if [ "$found" = "0" ]; then
  echo "  30031 / 30032 上没有在跑的东西，已经是停止状态。"
else
  echo "  已停止。"
fi
echo
read -n 1 -s -r -p "  按任意键关闭这个窗口。"
echo
