/**
 * 只放麦克风；其余一律拒绝。桌面版没有别的需要系统权限的能力。
 *
 * `mediaTypes` 是 Chromium 给的细分：这个应用只录声音，所以带 `video`（摄像头）
 * 的请求一律拒——`media` 这个权限同时管摄像头和麦克风，光看权限名会把摄像头
 * 一起放进来。拿不到细分时按老行为只认 `media`（麦克风）。
 */
export function decidePermission(permission: string, mediaTypes?: readonly string[]): boolean {
  if (permission !== 'media') return false;
  if (!mediaTypes || mediaTypes.length === 0) return true;
  return mediaTypes.includes('audio') && !mediaTypes.includes('video');
}
