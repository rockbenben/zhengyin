/** 只放麦克风；其余一律拒绝。桌面版没有别的需要系统权限的能力。 */
export function decidePermission(permission: string): boolean {
  return permission === 'media';
}
