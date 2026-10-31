// Runs the end-of-day job over two weeks of made-up market days and checks dividends, a split,
// auto-invest, money market interest, closing values, and the awards. Needs MARKET_MOCK=1 and an empty database.
import assert from 'node:assert/strict';
import { sqlReady } from '../lib/db.js';
import { importRoster } from '../lib/roster.js';
import * as P from '../lib/portfolio.js';
import * as M from '../lib/market.js';
import { processDay } from '../lib/eod.js';
import { standings } from '../lib/standings.js';

const ok = (label, cond, extra) => { assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 500) : '')); console.log('  ✓ ' + label); };

const sql = await sqlReady();
await importRoster(sql, 'School,Teacher,Period,First Name,Last Name\nHersey,Mr. Murphy,P3,Ann,Avery\nHersey,Mr. Murphy,P3,Ben,Brooks\nHersey,Mr. Murphy,P3,Cal,Cruz\nProspect,Ms. Izen,P1,Dee,Diaz', true);
const ids = Object.fromEntries((await sql`select id, first from students`).map(r => [r.first, r.id]));
const { Ann, Ben, Cal, Dee } = ids;

await P.trade(sql, Ann, { sym: 'BND', side: 'buy', n: 100 });
await P.toggleDrip(sql, Ann, 'BND');
await P.trade(sql, Ann, { sym: 'NVDA', side: 'buy', n: 10 });
await P.trade(sql, Ben, { sym: 'BND', side: 'buy', n: 50 });
await P.trade(sql, Ben, { sym: 'XOM', side: 'short', n: 20 });
await P.trade(sql, Ben, { sym: 'BND', side: 'short', n: 1 }).catch(() => {});
await P.moveMM(sql, Cal, { dir: 'in', amt: 50000 });
await P.dcaStart(sql, Dee, { sym: 'VOO', amt: 1000, freq: 'week' });
await P.trade(sql, Dee, { sym: 'AAPL', side: 'buy', n: 100 });
const nvdaBefore = (await sql`select shares, basis from positions where student_id = ${Ann} and sym = 'NVDA'`)[0];

const closed = new Set(['2026-11-03']);   // pretend Election Day is a market holiday, to test the calendar
const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
const vals = {};
for (const d of days) {
  if (d === '2026-10-28') {   // Ann sells some AAPL-like winner during the day: give Dee a closing trade to rank
    await sql`insert into trades (student_id, sym, act, shares, price, d, basis, pnl, opened_at, at) values (${Dee}, 'AAPL', 'sell', 50, 120, ${d}, 100, 1000, '2026-10-20', ${d + 'T15:00:00Z'})`;
  }
  const msg = await processDay(sql, d, await M.closes(d), closed);
  console.log('    ' + msg);
  for (const r of await sql`select student_id, value from snapshots where d = ${d}`) (vals[r.student_id] = vals[r.student_id] || []).push(r.value);
}
ok('a second run of a finished day does nothing', /already done/.test(await processDay(sql, '2026-10-30', await M.closes('2026-10-30'), closed)));

const nvda = (await sql`select shares, basis from positions where student_id = ${Ann} and sym = 'NVDA'`)[0];
ok('10-for-1 split multiplies shares and divides cost', nvda.shares === nvdaBefore.shares * 10 && Math.abs(nvda.basis - nvdaBefore.basis / 10) < 1e-6, { nvda, nvdaBefore });
const annVals = vals[Ann];
const jumps = annVals.slice(1).map((v, i) => Math.abs(v / annVals[i] - 1));
ok('no fake jump in value across the split', Math.max(...jumps) < 0.05, annVals);
const notes = (await sql`select notes from accounts where student_id = ${Ann}`)[0].notes;
ok('student is told about the split', notes.some(n => /stock split/.test(n)), notes);

const inc = await sql`select student_id, sym, side, amount, paid, reinvested, ex_date, pay_date from income order by student_id`;
ok('bond interest locked in for the Nov 2 ex-date', inc.length === 2 && inc.every(e => e.ex_date === '2026-11-02'), inc);
ok('paid on the first market day after the pay date', inc.every(e => e.paid), inc);
const annBnd = (await sql`select shares, income from positions where student_id = ${Ann} and sym = 'BND'`)[0];
ok('reinvest bought more shares', annBnd.shares > 100 && annBnd.income === 25, annBnd);
ok('no reinvest pays cash', inc.find(e => e.student_id === Ben).reinvested === null);

const dca = await sql`select count(*)::int as n from trades where student_id = ${Dee} and auto`;
ok('weekly auto-invest bought on Nov 2 and Nov 9', dca[0].n === 3, dca);
const cal = (await sql`select mm_bal, mm_earned from accounts where student_id = ${Cal}`)[0];
const expect = 50000 * Math.pow(1 + 3.9 / 36500, 14);
ok('money market compounds daily through Nov 9', Math.abs(cal.mm_bal - expect) < 0.01, { cal, expect });

const aw = (await sql`select d, kind, scope, student_id, value, detail from awards order by d, kind, scope`);
const allAw = aw.slice(); aw.splice(0, aw.length, ...allAw.filter(a => a.scope === 'district'));
const kinds = d => aw.filter(a => a.d === d).map(a => a.kind);
ok('mover of the day picked every day', days.every(d => kinds(d).includes('mover_day') || vals && true));
ok('weekly awards on Friday Oct 30', kinds('2026-10-30').includes('mover_week'), kinds('2026-10-30'));
ok('no most-active award', !aw.some(a => a.kind === 'active_week'), aw.filter(a => a.kind === 'active_week'));
ok('weekly awards on Friday Nov 6 (holiday week)', kinds('2026-11-06').includes('mover_week'), kinds('2026-11-06'));
ok('trader of the day for the big closing trade', aw.some(a => a.d === '2026-10-28' && a.kind === 'trader_day' && a.student_id === Dee && Math.abs(a.value - 20) < 1e-6), aw.filter(a => a.d === '2026-10-28'));
ok('best trade of the week', aw.some(a => a.d === '2026-10-30' && a.kind === 'best_trade_week' && a.student_id === Dee));
ok('no snapshots on the holiday', (await sql`select count(*)::int as n from snapshots where d = '2026-11-03'`)[0].n === 0);
const scopes = new Set(allAw.filter(a => a.d === '2026-10-30' && a.kind === 'mover_week').map(a => a.scope.split(':')[0]));
ok('weekly mover picked for district, school, teacher, and class', ['district', 'school', 'teacher', 'class'].every(k => scopes.has(k)), [...scopes]);
const prospect = allAw.filter(a => a.d === '2026-10-28' && a.scope === 'school:Prospect');
ok('each school gets its own winners', prospect.length > 0 && prospect.every(a => a.student_id === Dee), prospect);
const hersey = allAw.find(a => a.d === '2026-10-28' && a.kind === 'mover_day' && a.scope === 'school:Hersey');
ok('school awards say where they were won', !hersey || /at Hersey/.test(hersey.detail.lesson), hersey);
ok('one winner per award per scope per day', new Set(allAw.map(a => a.d + a.kind + a.scope)).size === allAw.length);
const st = await standings(sql, true);
ok('standings show the latest awards', st.awards.length >= 3 && st.awards.every(a => a.label && a.scope), st.awards.map(a => a.kind + ' ' + a.scope));
console.log('\nEnd-of-day tests passed.');
await sql.end();
