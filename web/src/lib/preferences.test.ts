import { afterEach, expect, it, vi } from 'vitest';
import { loadHue, loadPaper, saveHue, savePaper } from './ink';
import { getPreference, loadDesktopPreferences, NS_KEY, setPreference } from './preferences';

afterEach(() => vi.unstubAllGlobals());

it('reads theme and capture settings after the desktop origin changes', async () => {
  const saved: Record<string, string> = {};
  const bridge = {
    preferences: async () => Object.freeze({ ...saved }),
    setPreference: async (key: string, value: string) => { saved[key] = value; },
  };
  const openAt = async (port: number) => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal('window', { location: { origin: `http://127.0.0.1:${port}` }, zhengyinDesktop: bridge });
    await loadDesktopPreferences();
    return storage;
  };
  await openAt(39201);
  saveHue(300);
  savePaper('dark');
  setPreference(NS_KEY, 'off');
  const storage = await openAt(39202);
  expect(storage.size).toBe(0);
  expect(loadHue()).toBe(300);
  expect(loadPaper()).toBe('dark');
  expect(getPreference(NS_KEY)).toBe('off');
});
