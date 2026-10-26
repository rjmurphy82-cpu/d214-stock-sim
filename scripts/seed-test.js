// Fills an empty TEST database with a made-up district: 12 teachers, ~300 students, trades, and
// two weeks of end-of-day history, so every screen has something to show. MARKET_MOCK=1 only.
import { sqlReady } from '../lib/db.js';
import { importRoster } from '../lib/roster.js';
import * as P from '../lib/portfolio.js';
import * as M from '../lib/market.js';
import { processDay } from '../lib/eod.js';
import fs from 'node:fs';

if (process.env.MARKET_MOCK !== '1') { console.error('Test data only: set MARKET_MOCK=1.'); process.exit(1); }
const sql = await sqlReady();
const T = [['Mr. Callahan','Hersey',['P2','P6']],['Ms. Novak','Prospect',['P3']],['Ms. Brooks','Hersey',['P1']],['Mr. Delgado','Buffalo Grove',['P4','P7']],
  ['Ms. Tran','Rolling Meadows',['P5']],['Mr. Kowalczyk','Elk Grove',['P2']],['Ms. Sandoval','Wheeling',['P3','P8']],['Mr. Fitzgerald','Buffalo Grove',['P6']],
  ['Ms. Adeyemi','Elk Grove',['P1']],['Mr. Lindgren','Rolling Meadows',['P4','P5']],['Mr. Hollis','Wheeling',['P7']],['Ms. Pryor','Prospect',['P3']]];
const F = 'Aiden Bella Caleb Dani Eli Fiona Gabe Hana Ian Jade Kai Lena Mateo Nora Omar Piper Quinn Rosa Sam Tess Uma Vince Wren Xavier Yara Zoe Adam Brooke Carlos Dylan Erin Felix Gia Henry Isla Jonah Kira Leo Mia Nate Olive Paul Ruby Seth Tara Victor Will Zara'.split(' ');
const L = 'Martin Miller Moore Nguyen Olsen Patel Quinn Reyes Smith Torres Underwood Vance Walsh Young Zhang Adams Baker Clark Diaz Evans'.split(' ');
const rows = ['School,Teacher,Period,First Name,Last Name']; let k = 0;
for (const [t, s, ps] of T) for (const p of ps) for (let i = 0; i < (ps.length > 1 ? 13 : 25); i++, k++) rows.push(`${s},${t},${p},${F[k % F.length]},${L[(k * 7 + i) % L.length]}`);
rows.push('Hersey,Mr. Callahan,P2,Jack,Martin');
const r = await importRoster(sql, rows.join('\n'), true);
fs.writeFileSync(process.env.SLIPS || '/tmp/slips.json', JSON.stringify(r.slips, null, 1));

const ids = (await sql`select id from students order by id`).map(x => x.id);
const picks = ['NVDA','AAPL','MSFT','AMZN','COST','JPM','XOM','META','TSLA','GOOGL','V','BND','TLT','GBTC','VOO','QQQ','SCHD'];
let seed = 214; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (const id of ids) {
  const n = 2 + Math.floor(rnd() * 4);
  for (let j = 0; j < n; j++) {
    const sym = picks[Math.floor(rnd() * picks.length)];
    try { await P.trade(sql, id, { sym, side: rnd() < 0.08 && sym !== 'BND' && sym !== 'TLT' ? 'short' : 'buy', n: 5 + Math.floor(rnd() * 60) }); } catch {}
  }
  if (rnd() < 0.3) await P.moveMM(sql, id, { dir: 'in', amt: 2000 + Math.floor(rnd() * 10) * 1000 });
}
// Back-date everything two weeks and replay end of day for each market day since.
const start = M.addDays(M.today(), -15);
await sql`update trades set d = ${start}, at = ${start + 'T15:00:00Z'}`;
await sql`update positions set opened_at = ${start + 'T15:00:00Z'}`;
await sql`update accounts set mm_last = ${start}`;
const closed = new Set();
for (let d = start; d < M.today(); d = M.addDays(d, 1)) {
  if (!M.isWeekday(d)) continue;
  // a few students sell something each day, for the trade awards
  for (const id of ids.filter(() => rnd() < 0.05)) {
    const [p] = await sql`select sym, shares from positions where student_id = ${id} and side = 'long' limit 1`;
    if (p) { try { await P.trade(sql, id, { sym: p.sym, side: 'sell', n: Math.max(1, Math.floor(p.shares / 2)) }); } catch {} await sql`update trades set d = ${d}, at = ${d + 'T18:00:00Z'} where student_id = ${id} and d > ${d}`; }
  }
  console.log(await processDay(sql, d, await M.closes(d), closed));
}
console.log('seeded', ids.length, 'students');
await sql.end();
