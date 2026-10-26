// The game's rules: every trade, money market move, and auto-invest plan is checked and
// executed here, on the server, at the live Massive price. The page only displays the result.
import { HttpError, bad } from './http.js';
import * as M from './market.js';

export const START_CASH = 100000;
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 10000) / 10000;
const r6 = x => Math.round(x * 1e6) / 1e6;

/* ---------- settings the district admin controls ---------- */
const DEFAULTS = { mmRate: 3.9, trading: true, minPrice: 1, minShortPrice: 5, spyStart: null, startDate: null, eodRunning: null };
export async function getSettings(sql) {
  const s = { ...DEFAULTS };
  for (const r of await sql`select k, v from settings`) s[r.k] = r.v;
  return s;
}
export async function setSetting(sql, k, v) {
  await sql`insert into settings (k, v) values (${k}, ${sql.json(v)}) on conflict (k) do update set v = excluded.v`;
}

/* ---------- dates ---------- */
export function weekStart(d) {   // Monday of d's week
  const t = new Date(d + 'T12:00:00Z'), w = (t.getUTCDay() + 6) % 7;
  return M.addDays(d, -w);
}
function nextBizDay(d) { let x = d; while (!M.isWeekday(x)) x = M.addDays(x, 1); return x; }
function addMonth(d) { const t = new Date(d + 'T12:00:00Z'); t.setUTCMonth(t.getUTCMonth() + 1); return t.toISOString().slice(0, 10); }
export function dcaNext(d, freq) { return nextBizDay(freq === 'month' ? addMonth(d) : M.addDays(d, freq === '2week' ? 14 : 7)); }

/* ---------- money market: interest compounds daily at the admin's rate ---------- */
export async function settleMM(tx, rate, d, sid = null) {
  const daily = 1 + rate / 36500;
  await tx`
    update accounts set
      mm_earned = mm_earned + mm_bal * (power(${daily}::numeric, (${d}::date - coalesce(mm_last, ${d}::date))::numeric) - 1),
      mm_bal    = mm_bal * power(${daily}::numeric, (${d}::date - coalesce(mm_last, ${d}::date))::numeric),
      mm_last   = ${d}::date
    where (mm_last is null or mm_last < ${d}::date) ${sid === null ? tx`` : tx`and student_id = ${sid}`}`;
}
export function mmValueOn(bal, last, rate, d) {
  if (!last || !bal) return bal || 0;
  const days = Math.max(0, Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(last + 'T12:00:00Z')) / 86400000));
  return bal * Math.pow(1 + rate / 36500, days);
}

/* ---------- checks before any trade ---------- */
async function requireOpen(settings) {
  if (!settings.trading) throw new HttpError(409, 'Trading is paused right now. Check with your teacher.');
  if (process.env.ALLOW_CLOSED_TRADES === '1') return;
  const st = await M.status();
  if (st !== 'open') throw new HttpError(409, 'The market is closed. Trades go through 8:30 AM to 3:00 PM Central on days the market is open.');
}
async function livePrice(sym) {
  const q = (await M.quotes([sym], 3000))[sym];
  if (!q || !(q.p > 0)) throw new HttpError(409, 'No live price for ' + sym + ' right now. Try again in a minute.');
  return q.p;
}
function cleanSym(s) {
  const sym = String(s || '').toUpperCase().trim();
  if (!M.TICKER.test(sym)) throw bad('Pick a stock or fund first.');
  return sym;
}
function cleanShares(n) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) throw bad('Enter how many shares.');
  n = r4(n);
  if (n < 0.0001 || n > 10_000_000) throw bad('That share count doesn’t work.');
  return n;
}

async function addLong(tx, sid, sym, n, price) {
  await tx`
    insert into positions (student_id, sym, side, shares, basis) values (${sid}, ${sym}, 'long', ${n}, ${price})
    on conflict (student_id, sym, side) do update set
      basis = (positions.basis * positions.shares + excluded.basis * excluded.shares) / (positions.shares + excluded.shares),
      shares = positions.shares + excluded.shares`;
}

/* ---------- buy, sell, short, close a short ---------- */
export async function trade(sql, sid, body) {
  const sym = cleanSym(body.sym), side = String(body.side || '');
  if (!['buy', 'sell', 'short', 'cover'].includes(side)) throw bad('Pick buy, sell, or short.');
  let n = cleanShares(body.n);
  const settings = await getSettings(sql);
  await requireOpen(settings);
  const info = await M.assetInfo(sql, sym);
  if ((side === 'short' || side === 'cover') && info.kind === 'bond') throw bad('Bond funds can’t be shorted.');
  const price = await livePrice(sym);
  if (side === 'buy' && price < settings.minPrice) throw bad(`Stocks under $${settings.minPrice} a share can’t be bought in this game.`);
  if (side === 'short' && price < settings.minShortPrice) throw bad(`Stocks under $${settings.minShortPrice} a share can’t be shorted in this game.`);
  const d = M.today();
  return sql.begin(async tx => {
    const [a] = await tx`select cash from accounts where student_id = ${sid} for update`;
    if (!a) throw new HttpError(404, 'Account not found.');
    const posSide = side === 'buy' || side === 'sell' ? 'long' : 'short';
    const [p] = await tx`select shares, basis, opened_at from positions where student_id = ${sid} and sym = ${sym} and side = ${posSide}`;
    if (side === 'buy' || side === 'short') {
      const cost = r2(price * n);
      if (cost > a.cash + 0.005) throw bad('Not enough cash. You have $' + a.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '.');
      await tx`update accounts set cash = cash - ${cost} where student_id = ${sid}`;
      if (side === 'buy') await addLong(tx, sid, sym, n, price);
      else await tx`
        insert into positions (student_id, sym, side, shares, basis) values (${sid}, ${sym}, 'short', ${n}, ${price})
        on conflict (student_id, sym, side) do update set
          basis = (positions.basis * positions.shares + excluded.basis * excluded.shares) / (positions.shares + excluded.shares),
          shares = positions.shares + excluded.shares`;
      await tx`insert into trades (student_id, sym, act, shares, price, d) values (${sid}, ${sym}, ${side}, ${n}, ${price}, ${d})`;
      return { act: side, sym, n, price, total: cost };
    }
    if (!p) throw bad(side === 'sell' ? 'You don’t own any ' + sym + '.' : 'You aren’t short ' + sym + '.');
    if (n > p.shares + 0.00005) throw bad('You only have ' + p.shares + ' shares.');
    n = Math.min(n, p.shares);
    const proceeds = side === 'sell' ? r6(n * price) : r6(n * (2 * p.basis - price));
    const pnl = side === 'sell' ? r6((price - p.basis) * n) : r6((p.basis - price) * n);
    await tx`update accounts set cash = cash + ${proceeds} where student_id = ${sid}`;
    if (p.shares - n < 0.0001) await tx`delete from positions where student_id = ${sid} and sym = ${sym} and side = ${posSide}`;
    else await tx`update positions set shares = shares - ${n} where student_id = ${sid} and sym = ${sym} and side = ${posSide}`;
    await tx`insert into trades (student_id, sym, act, shares, price, d, basis, pnl, opened_at)
             values (${sid}, ${sym}, ${side}, ${n}, ${price}, ${d}, ${p.basis}, ${pnl}, ${p.opened_at})`;
    return { act: side, sym, n, price, total: r2(proceeds), pnl: r2(pnl) };
  });
}

/* ---------- money market ---------- */
export async function moveMM(sql, sid, body) {
  const dir = body.dir === 'out' ? 'out' : 'in';
  let amt = r2(Number(body.amt));
  if (!isFinite(amt) || amt <= 0) throw bad('Enter an amount.');
  const settings = await getSettings(sql);
  if (!settings.trading) throw new HttpError(409, 'Trading is paused right now. Check with your teacher.');
  const d = M.today();
  return sql.begin(async tx => {
    await tx`select 1 from accounts where student_id = ${sid} for update`;
    await settleMM(tx, settings.mmRate, d, sid);
    const [a] = await tx`select cash, mm_bal from accounts where student_id = ${sid}`;
    const avail = dir === 'in' ? a.cash : a.mm_bal;
    if (amt > avail + 0.01) throw bad(dir === 'in' ? 'That’s more cash than you have.' : 'That’s more than your money market balance.');
    amt = Math.min(amt, avail);
    if (dir === 'in') await tx`update accounts set cash = cash - ${amt}, mm_bal = mm_bal + ${amt} where student_id = ${sid}`;
    else await tx`update accounts set cash = cash + ${amt}, mm_bal = greatest(0, mm_bal - ${amt}) where student_id = ${sid}`;
    return { dir, amt };
  });
}

/* ---------- auto-invest (dollar cost averaging) ---------- */
export async function dcaStart(sql, sid, body) {
  const sym = cleanSym(body.sym), freq = String(body.freq || '');
  if (!['week', '2week', 'month'].includes(freq)) throw bad('Pick how often.');
  const amt = r2(Number(body.amt));
  if (!isFinite(amt) || amt < 10 || amt > 100000) throw bad('Pick an amount from $10 to $100,000.');
  const settings = await getSettings(sql);
  await requireOpen(settings);
  await M.assetInfo(sql, sym);
  const price = await livePrice(sym);
  if (price < settings.minPrice) throw bad(`Stocks under $${settings.minPrice} a share can’t be bought in this game.`);
  const d = M.today();
  return sql.begin(async tx => {
    const [a] = await tx`select cash from accounts where student_id = ${sid} for update`;
    if (amt > a.cash + 0.005) throw bad('Not enough cash for the first buy.');
    const [dupe] = await tx`select id from dca_plans where student_id = ${sid} and sym = ${sym}`;
    if (dupe) throw bad('You already auto-invest in ' + sym + '. Change it from My Portfolio.');
    const [plan] = await tx`insert into dca_plans (student_id, sym, amount, freq, next_date) values (${sid}, ${sym}, ${amt}, ${freq}, ${dcaNext(d, freq)}) returning id, next_date`;
    const sh = r4(amt / price);
    await tx`update accounts set cash = cash - ${amt} where student_id = ${sid}`;
    await addLong(tx, sid, sym, sh, amt / sh);
    await tx`insert into trades (student_id, sym, act, shares, price, d, auto, dca_id) values (${sid}, ${sym}, 'buy', ${sh}, ${price}, ${d}, true, ${plan.id})`;
    return { sym, amt, freq, next: plan.next_date, shares: sh, price };
  });
}
export async function dcaToggle(sql, sid, id) {
  const d = M.today();
  const [p] = await sql`select paused, next_date from dca_plans where id = ${id} and student_id = ${sid}`;
  if (!p) throw bad('That plan is gone.');
  const next = p.paused && p.next_date <= d ? nextBizDay(M.addDays(d, 1)) : p.next_date;
  await sql`update dca_plans set paused = not paused, next_date = ${next} where id = ${id} and student_id = ${sid}`;
}
export async function dcaStop(sql, sid, id) {
  await sql`delete from dca_plans where id = ${id} and student_id = ${sid}`;
}

/* ---------- small settings on the account ---------- */
export async function toggleDrip(sql, sid, sym) {
  await sql`update positions set drip = not drip where student_id = ${sid} and sym = ${cleanSym(sym)} and side = 'long'`;
}
export async function setWatch(sql, sid, sym, on) {
  sym = cleanSym(sym);
  if (on) await sql`update accounts set watch = array_append(array_remove(watch, ${sym}), ${sym}) where student_id = ${sid} and coalesce(array_length(watch, 1), 0) < 40`;
  else await sql`update accounts set watch = array_remove(watch, ${sym}) where student_id = ${sid}`;
}
export async function dismissNotes(sql, sid) {
  await sql`update accounts set notes = '[]'::jsonb where student_id = ${sid}`;
}
export async function addNote(tx, sid, text) {
  await tx`update accounts set notes = (case when jsonb_array_length(notes) >= 12 then notes - 0 else notes end) || ${tx.json([text])} where student_id = ${sid}`;
}

/* ---------- everything the page needs to draw one student's portfolio ---------- */
function heldText(from, to) {
  if (!from) return '';
  const days = Math.max(0, Math.round((new Date(to) - new Date(from)) / 86400000));
  return days === 0 ? 'same day' : days === 1 ? '1 day' : days + ' days';
}

export async function pendingSplits(sql) {
  const rows = await sql`select sym, ratio from splits where exec_date > ${M.today()}`;
  return Object.fromEntries(rows.map(r => [r.sym, r.ratio]));
}

export async function portfolioState(sql, sid) {
  const settings = await getSettings(sql);
  const [a] = await sql`select * from accounts where student_id = ${sid}`;
  if (!a) throw new HttpError(404, 'Account not found.');
  const [pos, trades, plans, inc, hist, adj] = await Promise.all([
    sql`select sym, side, shares, basis, drip, income, opened_at from positions where student_id = ${sid} order by opened_at`,
    sql`select id, sym, act, shares, price, at, d, auto, dca_id, basis, pnl, opened_at from trades where student_id = ${sid} order by at`,
    sql`select id, sym, amount, freq, next_date, paused from dca_plans where student_id = ${sid} order by id`,
    sql`select sym, side, ex_date, pay_date, per_share, shares, amount, paid, reinvested from income where student_id = ${sid} order by ex_date desc limit 60`,
    sql`select s.d, s.value, m.spy from snapshots s left join market_days m on m.d = s.d where s.student_id = ${sid} order by s.d`,
    pendingSplits(sql)
  ]);
  const wk = weekStart(M.today());
  const P = {
    cash: a.cash,
    pos: pos.map(p => ({ sym: p.sym, side: p.side, n: p.shares, b: p.basis, drip: p.drip, income: p.income })),
    mm: { bal: a.mm_bal, rate: settings.mmRate, earned: a.mm_earned, last: a.mm_last || M.today() },
    closed: trades.filter(t => t.act === 'sell' || t.act === 'cover').map(t => t.act === 'sell'
      ? { sym: t.sym, n: t.shares, b: t.basis, s: t.price, d: heldText(t.opened_at, t.at) }
      : { sym: t.sym + ' (short)', n: t.shares, b: t.price, s: t.basis, d: heldText(t.opened_at, t.at) }),
    tradesWeek: trades.filter(t => !t.auto && t.d >= wk).length,
    watch: a.watch || [],
    log: trades.map(t => ({ sym: t.sym, act: t.act, n: t.shares, price: t.price, date: t.d, auto: t.auto })),
    dca: plans.map(pl => ({ id: String(pl.id), sym: pl.sym, amt: pl.amount, freq: pl.freq, next: pl.next_date, paused: pl.paused,
      buys: trades.filter(t => t.dca_id === pl.id).map(t => ({ date: t.d, price: t.price, sh: t.shares })) })),
    income: inc.slice().reverse().map(e => ({ sym: e.sym, side: e.side, ex: e.ex_date, pay: e.pay_date, perShare: e.per_share, shares: e.shares, amount: e.amount, paid: e.paid, reinvested: e.reinvested })),
    notes: Array.isArray(a.notes) ? a.notes : [],
    spyStart: a.spy_start || settings.spyStart || null,
    adj
  };
  const syms = [...new Set([...P.pos.map(p => p.sym), ...P.log.map(l => l.sym), ...P.watch, ...P.dca.map(x => x.sym), ...P.income.map(x => x.sym)])];
  const meta = syms.length ? Object.fromEntries((await sql`select sym, name, kind from symbols where sym = any(${syms})`).map(r => [r.sym, [r.name, r.kind]])) : {};
  const history = hist.map(h => ({ d: h.d, v: h.value, spy: h.spy }));
  // Prices for everything on the page, so it can draw right away. Falls back to the last known price.
  let qs = {};
  try { qs = await M.quotes(syms.concat('SPY')); } catch { /* use last known */ }
  const lp = await M.lastPrices(sql, syms.concat('SPY').filter(s => !qs[s]));
  const quotes = Object.fromEntries(Object.entries(lp).map(([s, p]) => [s, { p, pc: p, stale: true }]));
  for (const [s, q] of Object.entries(qs)) quotes[s] = { p: q.p, pc: q.pc };
  let market = 'unknown'; try { market = await M.status(); } catch { /* unknown */ }
  return { P, meta, history, quotes, market, settings: { mmRate: settings.mmRate, trading: settings.trading, minPrice: settings.minPrice, minShortPrice: settings.minShortPrice, startDate: settings.startDate, spyStart: settings.spyStart } };
}
