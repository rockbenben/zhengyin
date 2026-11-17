import { expect, it } from 'vitest';
import { decidePermission } from './permissions.js';

it('只放麦克风', () => {
  expect(decidePermission('media')).toBe(true);
  expect(decidePermission('media', ['audio'])).toBe(true);
  expect(decidePermission('media', ['video'])).toBe(false);
  expect(decidePermission('media', ['audio', 'video'])).toBe(false);
  expect(decidePermission('notifications')).toBe(false);
  expect(decidePermission('geolocation')).toBe(false);
  expect(decidePermission('display-capture')).toBe(false);
});
