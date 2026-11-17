import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from './review.js';
const fault = vi.hoisted(() => ({ fail: true }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
    if (fault.fail) throw new Error('copy failed');
    return fs.copyFileSync(...args);
  }};
});
it('retries a failed initial backup before overwriting corrupt progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-backup-'));
  const file = join(dir, 'review-state.json');
  writeFileSync(file, 'broken fixture');
  const review = new ReviewStore(file);
  expect(() => review.addCard('cat', '2026-11-17')).toThrow('copy failed');
  expect(readFileSync(file, 'utf8')).toBe('broken fixture');
  fault.fail = false;
  review.addCard('cat', '2026-11-17');
  expect(readdirSync(dir).some(f => f.includes('.corrupt-'))).toBe(true);
});
