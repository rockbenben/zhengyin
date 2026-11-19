import { desktopBridge } from './desktop';

export const HUE_KEY = 'overprint.hue';
export const PAPER_KEY = 'overprint.paper';
export const NS_KEY = 'pron:noise-suppression';
export const SHOW_PLANS_KEY = 'pron:ai-show-subscription-plans';

let desktopPreferences: Record<string, string> = {};

export async function loadDesktopPreferences(): Promise<void> {
  const bridge = desktopBridge();
  if (!bridge) return;
  try {
    desktopPreferences = { ...await bridge.preferences() };
    for (const key of [HUE_KEY, PAPER_KEY, NS_KEY, SHOW_PLANS_KEY]) {
      const legacy = localStorage.getItem(key);
      if (legacy !== null && !Object.hasOwn(desktopPreferences, key)) setPreference(key, legacy);
    }
  } catch { /* 桌面设置读不到就退回浏览器里那份：这个 origin 的 localStorage 还在。 */ }
}

export function getPreference(key: string): string | null {
  if (Object.hasOwn(desktopPreferences, key)) return desktopPreferences[key];
  try { return localStorage.getItem(key); } catch { return null; }
}

export function setPreference(key: string, value: string): void {
  const bridge = desktopBridge();
  if (bridge) {
    desktopPreferences[key] = value;
    void bridge.setPreference(key, value).catch(() => {});
  }
  try { localStorage.setItem(key, value); } catch { /* localStorage 存不下就算了：浏览器里只是这次生效，桌面版那份另有主进程存。 */ }
}
