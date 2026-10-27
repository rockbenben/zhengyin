import { expect, it } from 'vitest';
import { decidePermission } from './permissions.js';

it('只放麦克风', () => {
  expect(decidePermission('media')).toBe(true);
  expect(decidePermission('notifications')).toBe(false);
  expect(decidePermission('geolocation')).toBe(false);
});
