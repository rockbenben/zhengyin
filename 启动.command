#!/bin/bash
# macOS：双击这个文件就会在「终端」里跑起来。
# 扩展名必须是 .command——.sh 在 macOS 上双击是用编辑器打开，不会执行。
cd "$(dirname "$0")" || exit 1

echo
echo "  正音"
echo "  ────────────────────────────────"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  没找到 Node.js —— 这个工具要靠它才能跑。"
  echo
  echo "  去 https://nodejs.org 下载安装（选 LTS 那个版本，需要 20.19 或更新），"
  echo "  装完之后再双击这个文件就行。"
  echo
  read -n 1 -s -r -p "  按任意键关闭"
  exit 1
fi

if [ ! -f server/dist/index.js ]; then
  echo "  第一次启动：要先装依赖再构建，大约一两分钟。"
  echo "  只有这一次慢，之后都是几秒。"
  echo
  npm run go
else
  echo "  正在启动…浏览器会自己打开，不用手敲网址。"
  echo "  逐音素评测的识别服务要多等十几秒加载模型。"
  echo
  npm start
fi

status=$?

echo
echo "  ────────────────────────────────"
# 结束语不断言服务状态：装失败时它从来没起来过（Node 太老会让 npm install 倒掉），
# 而顺利退出也可能是"它本来就在跑、这次根本没起第二个"。两种都不是"已停止"。
if [ "$status" -ne 0 ]; then
  read -n 1 -s -r -p "  没能起来。原因写在上面，照着做完再跑一次。按任意键关闭。"
else
  read -n 1 -s -r -p "  按任意键关闭这个窗口。"
fi
echo
