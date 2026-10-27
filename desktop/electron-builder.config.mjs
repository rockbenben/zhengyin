// 打包配置的占位骨架：完整内容（资源清单、依赖闭包、两份 target）在 Task 15 补齐。
// 这份文件之所以现在就有，是让身份守卫能读到 appId 与产物名。
export default {
  appId: 'com.rockbenben.zhengyin',
  productName: '正音',
  win: { artifactName: 'zhengyin-${version}-win.${ext}' },
  nsis: { artifactName: 'zhengyin-${version}-win-setup.${ext}' },
};
