// Checks how limit, stop, stop limit, and trailing stop orders fill against one-minute bars.
// No database or market data needed:  node scripts/test-orders.js
import assert from 'node:assert/strict';
import { evalOrder } from '../lib/portfolio.js';

const T0 = Date.UTC(2026, 10, 6, 15, 0);           // 10:00 AM New York
const bar = (i, o, h, l) => ({ t: T0 + i * 60000, o, h, l });
const always = () => true;
const order = x => ({ placed_at: new Date(T0 - 1000), checked_to: null, expires_at: new Date(T0 + 3600e3), est: 100, mark: null, trail: null, lim: null, stop: null, triggered_at: null, ...x });
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

ok('limit buy waits, then fills at the limit', () => {
  const r = evalOrder(order({ otype: 'limit', side: 'buy', lim: 95 }), [bar(0, 100, 101, 99), bar(1, 97, 98, 94), bar(2, 93, 94, 92)], always);
  assert.deepEqual(r.fill, { t: T0 + 60000, price: 95 });
});
ok('limit buy that opens below the limit gets the better price', () => {
  const r = evalOrder(order({ otype: 'limit', side: 'buy', lim: 95 }), [bar(0, 93, 96, 92)], always);
  assert.equal(r.fill.price, 93);
});
ok('limit sell fills at or above the limit', () => {
  const r = evalOrder(order({ otype: 'limit', side: 'sell', lim: 105 }), [bar(0, 100, 104, 99), bar(1, 106, 107, 105)], always);
  assert.equal(r.fill.price, 106);
});
ok('stop loss sells at the stop', () => {
  const r = evalOrder(order({ otype: 'stop', side: 'sell', stop: 90 }), [bar(0, 95, 96, 91), bar(1, 91, 92, 89)], always);
  assert.deepEqual(r.fill, { t: T0 + 60000, price: 90 });
});
ok('stop loss on a gap down sells at the lower opening price', () => {
  const r = evalOrder(order({ otype: 'stop', side: 'sell', stop: 90 }), [bar(0, 85, 86, 84)], always);
  assert.equal(r.fill.price, 85);
});
ok('buy stop (or covering a short) triggers going up', () => {
  const r = evalOrder(order({ otype: 'stop', side: 'cover', stop: 110 }), [bar(0, 105, 109, 104), bar(1, 109, 111, 108)], always);
  assert.equal(r.fill.price, 110);
});
ok('stop limit: gap below the limit triggers but does not fill', () => {
  const r = evalOrder(order({ otype: 'stop_limit', side: 'sell', stop: 90, lim: 88 }), [bar(0, 85, 86, 84)], always);
  assert.equal(r.fill, null); assert.equal(r.trigAt, T0);
});
ok('stop limit: fills later once back at the limit', () => {
  const o = order({ otype: 'stop_limit', side: 'sell', stop: 90, lim: 88, triggered_at: new Date(T0), checked_to: T0 });
  const r = evalOrder(o, [bar(0, 85, 86, 84), bar(1, 86, 87, 85), bar(2, 87, 89, 86)], always);
  assert.deepEqual(r.fill, { t: T0 + 120000, price: 88 });
});
ok('stop limit: normal trigger fills at the stop', () => {
  const r = evalOrder(order({ otype: 'stop_limit', side: 'sell', stop: 90, lim: 88 }), [bar(0, 92, 93, 89.5)], always);
  assert.equal(r.fill.price, 90);
});
ok('trailing stop follows the price up, then sells', () => {
  const r = evalOrder(order({ otype: 'trail', side: 'sell', trail: 10, mark: 100 }), [bar(0, 100, 120, 99), bar(1, 119, 119, 109), bar(2, 109, 109, 107)], always);
  assert.deepEqual(r.fill, { t: T0 + 120000, price: 108 });   // 10% below the $120 high
});
ok('trailing stop never triggers on a level set in the same minute', () => {
  const r = evalOrder(order({ otype: 'trail', side: 'sell', trail: 10, mark: 100 }), [bar(0, 100, 120, 95)], always);
  assert.equal(r.fill, null); assert.equal(r.mark, 120);
});
ok('prices from before the click never count', () => {
  const o = order({ otype: 'limit', side: 'buy', lim: 95, placed_at: new Date(T0 + 30000) });
  const r = evalOrder(o, [bar(0, 90, 91, 89), bar(1, 99, 100, 98)], always);
  assert.equal(r.fill, null); assert.equal(r.last, T0 + 60000);
});
ok('already-checked bars are skipped', () => {
  const r = evalOrder(order({ otype: 'limit', side: 'buy', lim: 95, checked_to: T0 }), [bar(0, 90, 91, 89), bar(1, 99, 100, 98)], always);
  assert.equal(r.fill, null);
});
ok('nothing fills after the order ends', () => {
  const o = order({ otype: 'limit', side: 'buy', lim: 95, expires_at: new Date(T0 + 60000) });
  const r = evalOrder(o, [bar(0, 99, 100, 98), bar(1, 90, 91, 89)], always);
  assert.equal(r.fill, null); assert.equal(r.last, T0 + 60000);
});
ok('before- and after-hours bars are skipped', () => {
  const r = evalOrder(order({ otype: 'limit', side: 'buy', lim: 95 }), [bar(0, 90, 91, 89), bar(1, 99, 100, 98)], t => t !== T0);
  assert.equal(r.fill, null);
});
console.log(n + ' order checks passed');
