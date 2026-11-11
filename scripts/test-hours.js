// Checks when the game says the market is open: regular hours, daylight saving time, weekends, holidays,
// early closes, and how Massive's live status is used as a backup.
// No database or market data needed:  node scripts/test-hours.js
import assert from 'node:assert/strict';
import { calendarFrom, sessionOn, sessionFrom, marketAt, isRegular } from '../lib/market.js';

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
// A moment given as Central time (handles daylight saving time the same way Chicago does).
const at = (d, hm) => {
  for (const off of [5, 6]) {
    const t = Date.parse(d + 'T' + hm + ':00Z') + off * 3600000;
    const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (s === hm) return t;
  }
  throw new Error('bad time ' + d + ' ' + hm);
};

// The shape Massive's /v1/marketstatus/upcoming returns.
const CAL = calendarFrom([
  { exchange: 'NYSE', name: 'Thanksgiving', date: '2026-11-26', status: 'closed' },
  { exchange: 'NASDAQ', name: 'Thanksgiving', date: '2026-11-26', status: 'closed' },
  { exchange: 'NYSE', name: 'Thanksgiving', date: '2026-11-27', status: 'early-close', open: '2026-11-27T14:30:00.000Z', close: '2026-11-27T18:00:00.000Z' },
  { exchange: 'NASDAQ', name: 'Thanksgiving', date: '2026-11-27', status: 'early-close', open: '2026-11-27T14:30:00.000Z', close: '2026-11-27T18:00:00.000Z' },
  { exchange: 'OTC', name: 'Something', date: '2026-12-01', status: 'closed' },
  { exchange: 'NYSE', name: 'Christmas', date: '2026-12-25', status: 'closed' }
]);
const open = (d, hm, live = null) => marketAt(at(d, hm), sessionFrom(at(d, hm), CAL), live) === 'open';

ok('opens at exactly 8:30 Central and not a minute before', () => {
  assert.equal(open('2026-11-11', '08:29'), false);
  assert.equal(open('2026-11-11', '08:30'), true);
});
ok('closes at exactly 3:00 Central', () => {
  assert.equal(open('2026-11-11', '14:59'), true);
  assert.equal(open('2026-11-11', '15:00'), false);
});
ok('same Central hours during daylight saving time (October)', () => {
  assert.equal(open('2026-10-14', '08:29'), false);
  assert.equal(open('2026-10-14', '08:30'), true);
  assert.equal(open('2026-10-14', '15:00'), false);
});
ok('closed on weekends', () => {
  assert.equal(open('2026-11-14', '10:00'), false);
  assert.equal(open('2026-11-15', '10:00'), false);
});
ok('closed all day on Thanksgiving', () => {
  assert.equal(open('2026-11-26', '10:00'), false);
  assert.equal(sessionOn('2026-11-26', CAL), null);
});
ok('day after Thanksgiving closes at noon Central', () => {
  assert.equal(open('2026-11-27', '08:30'), true);
  assert.equal(open('2026-11-27', '11:59'), true);
  assert.equal(open('2026-11-27', '12:00'), false);
  assert.equal(open('2026-11-27', '14:00'), false);
});
ok('limit and stop orders ignore after-hours prices on an early-close day', () => {
  assert.equal(isRegular(at('2026-11-27', '11:59')), true);
  assert.equal(isRegular(at('2026-11-27', '12:00')), false);
  assert.equal(isRegular(at('2026-11-11', '14:59')), true);
});
ok('a holiday listed only for another exchange is ignored', () => {
  assert.equal(open('2026-12-01', '10:00'), true);
});
ok('after the close, the page is told about the next session (left open overnight)', () => {
  const s = sessionFrom(at('2026-11-25', '18:00'), CAL);
  assert.equal(s.date, '2026-11-27');   // skips Thanksgiving
  const f = sessionFrom(at('2026-11-13', '16:00'), CAL);
  assert.equal(f.date, '2026-11-16');   // Friday evening -> Monday
});
ok('a cached "pre-market" answer from Massive right after the bell is ignored', () => {
  assert.equal(open('2026-11-11', '08:30', 'extended-hours'), true);
  assert.equal(open('2026-11-11', '08:32', 'extended-hours'), true);
});
ok('Massive saying closed later in the day wins (holiday missing from the calendar)', () => {
  assert.equal(open('2026-11-11', '08:34', 'closed'), false);
  assert.equal(open('2026-11-11', '12:30', 'extended-hours'), false);
});
ok('Massive saying open after the bell does not reopen trading', () => {
  const t = at('2026-11-11', '15:00');
  assert.equal(marketAt(t, sessionFrom(t, CAL), 'open'), 'extended-hours');
});
ok('no answer from Massive: the clock alone decides', () => {
  assert.equal(open('2026-11-11', '10:00', null), true);
  assert.equal(open('2026-11-11', '10:00', 'unknown'), true);
  assert.equal(open('2026-11-11', '07:00', null), false);
});
ok('empty or broken calendar still gives regular weekday hours', () => {
  const t = at('2026-11-27', '13:00');
  assert.equal(marketAt(t, sessionFrom(t, calendarFrom(null)), null), 'open');
});

console.log(`\n${n} market-hours checks passed`);
