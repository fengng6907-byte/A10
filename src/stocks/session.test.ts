import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketSession, marketHolidays } from './session';

test('NYSE session follows spring daylight saving shift', () => {
  assert.equal(marketSession(new Date('2026-03-06T15:00:00Z')).session, 'REGULAR');
  assert.equal(marketSession(new Date('2026-03-09T14:00:00Z')).session, 'REGULAR');
  assert.equal(marketSession(new Date('2026-03-09T13:00:00Z')).session, 'PREMARKET');
  assert.equal(marketSession(new Date('2026-11-02T15:00:00Z')).session, 'REGULAR');
  assert.equal(marketSession(new Date('2026-11-02T14:00:00Z')).session, 'PREMARKET');
});
test('NYSE holidays and early close block or shorten monitoring', () => {
  assert.ok(marketHolidays(2026).has('2026-04-03'));
  assert.ok(marketHolidays(2026).has('2026-07-03'));
  assert.equal(marketSession(new Date('2026-07-03T15:00:00Z')).session, 'CLOSED');
  assert.equal(marketSession(new Date('2026-11-27T17:00:00Z')).session, 'REGULAR');
  assert.equal(marketSession(new Date('2026-11-27T18:30:00Z')).session, 'AFTER_HOURS');
});
