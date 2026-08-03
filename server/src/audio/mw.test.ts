import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mwAudioUrl, fetchMwAudio } from './mw.js';

describe('mwAudioUrl subdir rules', () => {
  it('normal word → first letter', () => {
    expect(mwAudioUrl('click001')).toBe('https://media.merriam-webster.com/audio/prons/en/us/mp3/c/click001.mp3');
  });
  it('bix prefix → bix', () => {
    expect(mwAudioUrl('bix0001')).toContain('/mp3/bix/');
  });
  it('gg prefix → gg', () => {
    expect(mwAudioUrl('gg0001')).toContain('/mp3/gg/');
  });
  it('digit start → number', () => {
    expect(mwAudioUrl('3d000001')).toContain('/mp3/number/');
  });
});

describe('fetchMwAudio', () => {
  it('downloads first pronunciation audio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-'));
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ hwi: { prs: [{ sound: { audio: 'click001' } }] } }] })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    const file = await fetchMwAudio('click', 'KEY', dir, fetchFn as any);
    expect(file).toBe('click-mw.mp3');
    expect(existsSync(join(dir, 'click-mw.mp3'))).toBe(true);
  });

  it('returns null when word not found (suggestions array)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-'));
    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ['clack', 'clock'] });
    expect(await fetchMwAudio('zzz', 'KEY', dir, fetchFn as any)).toBeNull();
  });

  it('returns null on http error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-'));
    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: false });
    expect(await fetchMwAudio('click', 'KEY', dir, fetchFn as any)).toBeNull();
  });
});
