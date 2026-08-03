#!/bin/bash
# Linux。**说实话：这个文件不一定能双击。**
#
# 三个平台里只有 Linux 没有可靠的"双击跑脚本"约定——多数桌面环境（GNOME 尤其）
# 默认用编辑器打开 .sh，即使加了可执行位也一样，得去文件管理器的设置里改。
# 所以这里不假装它一定能双击，而是把两条路都说清楚：
#
#   · 文件管理器里右键 → 「以程序运行」/「Run as a Program」（不同发行版措辞不同）
#   · 或者终端里跑：./启动.sh
#
# 想要一个真的能点的图标，就做一个 .desktop 项（多花五分钟，但一次就好）：
#   把下面这段存成 ~/.local/share/applications/pronunciation.desktop
#   然后 chmod +x 它，之后它就出现在应用列表里、可以拖到任务栏：
#
#     [Desktop Entry]
#     Type=Application
#     Name=正音
#     Exec=/绝对路径/到这个仓库/启动.sh
#     Path=/绝对路径/到这个仓库
#     Terminal=true
#     Categories=Education;
#
cd "$(dirname "$0")" || exit 1

echo
echo "  正音"
echo "  ────────────────────────────────"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  没找到 Node.js —— 这个工具要靠它才能跑。"
  echo
  echo "  用发行版的包管理器装，或者去 https://nodejs.org 下 LTS 版本（需要 20.19 或更新）。"
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
