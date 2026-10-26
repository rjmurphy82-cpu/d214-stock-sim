// Market data for the server side of the game: live prices for trades and standings,
// official closing prices, dividends, splits, holidays, and what kind of investment a ticker is.
// Everything comes from Massive through the shared helper in api/_massive.js.
// MARKET_MOCK=1 swaps in made-up prices so the app can be tested without a key (never in production).
import { massive, cached, nyDate, toMs } from '../api/_massive.js';
import { HttpError } from './http.js';

const MOCK = process.env.MARKET_MOCK === '1';

// Funds the game treats as bond funds (no shorting, monthly interest) and crypto funds.
export const BOND = new Set('BND AGG TLT SHY BIL IEF TIP LQD HYG MUB BNDX SGOV SHV VGSH VGIT VGLT SCHZ SCHR SCHO SCHP IGIB VCIT VCSH VCLT BSV BIV BLV JNK GOVT EMB IUSB FLOT USFR TLH IEI SPTL SPTS SPTI SPAB VTIP STIP JPST MINT VTEB TFI'.split(' '));
export const CRYPTO = new Set('GBTC ETHE BTC ETH IBIT FBTC BITB ARKB HODL BRRR EZBC BTCO BTCW ETHA FETH ETHW CETH QETH EZET BITO BITX'.split(' '));
const KIND = { CS: 'stock', ADRC: 'stock', ETF: 'etf', ETN: 'etf', ETV: 'etf' };
export const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export const today = () => nyDate(Date.now());

/* ---------- live prices ---------- */
const QC = new Map();   // sym -> {t, q}
export async function quotes(syms, maxAgeMs = 20000) {
  const want = [...new Set(syms.filter(s => TICKER.test(s)))];
  const out = {}, missing = [];
  const now = Date.now();
  for (const s of want) {
    const hit = QC.get(s);
    if (hit && now - hit.t < maxAgeMs) out[s] = hit.q; else missing.push(s);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const got = MOCK ? mockQuotes(batch) : await fetchSnapshot(batch);
    for (const [s, q] of Object.entries(got)) { QC.set(s, { t: Date.now(), q }); out[s] = q; }
  }
  if (QC.size > 5000) QC.clear();
  return out;
}

async function fetchSnapshot(list) {
  const data = await massive('/v2/snapshot/locale/us/markets/stocks/tickers', { tickers: list.join(',') });
  const out = {};
  for (const t of data.tickers || []) {
    const pc = t.prevDay && t.prevDay.c > 0 ? t.prevDay.c : null;
    const p = [t.lastTrade && t.lastTrade.p, t.min && t.min.c, t.day && t.day.c, pc].find(v => typeof v === 'number' && v > 0);
    if (!p) continue;
    out[t.ticker] = { p, pc: pc || p, u: toMs(t.updated) || 0 };
  }
  return out;
}

/* ---------- market open or closed ---------- */
export async function status() {
  if (MOCK) return process.env.MOCK_MARKET || 'open';
  const s = await cached('status', 30000, () => massive('/v1/marketstatus/now'));
  return s.market || 'unknown';
}

// Dates the market is fully closed (holidays), from Massive's upcoming calendar.
export async function holidays() {
  if (MOCK) return new Set();
  try {
    const list = await cached('upcoming', 6 * 3600000, () => massive('/v1/marketstatus/upcoming'));
    return new Set((Array.isArray(list) ? list : []).filter(h => h.status === 'closed' && (!h.exchange || /NYSE|NASDAQ/i.test(h.exchange))).map(h => h.date));
  } catch { return new Set(); }
}

export const isWeekday = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6; };
export const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export function nextTradingDay(d, closed) {
  let x = addDays(d, 1);
  for (let k = 0; k < 10 && (!isWeekday(x) || closed.has(x)); k++) x = addDays(x, 1);
  return x;
}

/* ---------- official closing prices for one day ---------- */
export async function closes(date) {
  if (MOCK) return mockCloses(date);
  const data = await cached('grouped:' + date, 3600000, () => massive(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, { adjusted: 'true' }));
  const out = {};
  for (const r of data.results || []) if (r.T && r.c > 0) out[r.T] = r.c;
  return out;
}

/* ---------- dividends and splits ---------- */
async function allPages(path, params) {
  let data = await massive(path, params), rows = data.results || [], k = 0;
  while (data.next_url && k++ < 10) { data = await massive(data.next_url); rows = rows.concat(data.results || []); }
  return rows;
}

// Every cash dividend whose ex-dividend date is `date`.
export async function dividendsOn(date) {
  if (MOCK) return mockDividends(date);
  const rows = await allPages('/v3/reference/dividends', { ex_dividend_date: date, limit: 1000 });
  return rows.filter(r => r.cash_amount > 0 && r.pay_date && (!r.dividend_type || r.dividend_type === 'CD' || r.dividend_type === 'SC'))
    .map(r => ({ sym: r.ticker, ex: r.ex_dividend_date, pay: r.pay_date, amount: r.cash_amount }));
}

// Recent payments for one fund or stock: used for "about $X next payment" and the yield shown to students.
export async function dividendInfo(sym) {
  if (MOCK) return BOND.has(sym) ? { last: 0.25, lastEx: addDays(today(), -20), freq: 12, ttm: 3.0 } : { last: 0, lastEx: null, freq: 0, ttm: 0 };
  return cached('divinfo:' + sym, 12 * 3600000, async () => {
    const data = await massive('/v3/reference/dividends', { ticker: sym, limit: 24, order: 'desc', sort: 'ex_dividend_date' });
    const rows = (data.results || []).filter(r => r.cash_amount > 0);
    if (!rows.length) return { last: 0, lastEx: null, freq: 0, ttm: 0 };
    const yearAgo = addDays(today(), -365);
    return { last: rows[0].cash_amount, lastEx: rows[0].ex_dividend_date, freq: rows[0].frequency || 0,
      ttm: rows.filter(r => r.ex_dividend_date > yearAgo).reduce((a, r) => a + r.cash_amount, 0) };
  });
}

// Splits that take effect on `date`. ratio = new shares per old share.
export async function splitsOn(date) {
  if (MOCK) return (process.env.MOCK_SPLITS || '').split(',').filter(Boolean).map(x => x.split(':'))
    .filter(([, dd]) => dd === date).map(([sym, , ratio]) => ({ sym, ratio: Number(ratio) }));
  const rows = await allPages('/v3/reference/splits', { execution_date: date, limit: 1000 });
  return rows.filter(r => r.split_from > 0 && r.split_to > 0).map(r => ({ sym: r.ticker, ratio: r.split_to / r.split_from }));
}

/* ---------- what kind of investment is this? ---------- */
// Cached in the symbols table. Throws if the ticker isn't a U.S.-listed stock or ETF the game allows.
export async function assetInfo(sql, sym) {
  if (!TICKER.test(sym)) throw new HttpError(400, 'That isn’t a valid ticker.');
  const [row] = await sql`select name, kind from symbols where sym = ${sym}`;
  if (row && row.kind) return row;
  let name = sym, kind = null;
  if (MOCK) { name = sym + ' (test)'; kind = BOND.has(sym) ? 'bond' : CRYPTO.has(sym) ? 'crypto' : sym.length <= 3 && sym !== 'NVDA' ? 'etf' : 'stock'; }
  else {
    let r;
    try { r = (await cached('ov:' + sym, 86400000, () => massive('/v3/reference/tickers/' + encodeURIComponent(sym)))).results || {}; }
    catch (e) { if (e.status === 404) throw new HttpError(400, sym + ' isn’t a U.S. stock or fund you can trade here.'); throw e; }
    if (r.market !== 'stocks' || !KIND[r.type] || r.active === false) throw new HttpError(400, sym + ' isn’t a U.S. stock or fund you can trade here.');
    name = r.name || sym;
    kind = BOND.has(sym) ? 'bond' : CRYPTO.has(sym) ? 'crypto' : KIND[r.type];
  }
  await sql`insert into symbols (sym, name, kind) values (${sym}, ${name}, ${kind})
            on conflict (sym) do update set name = excluded.name, kind = excluded.kind`;
  return { name, kind };
}

// Keep each symbol's last known price so a stock that stops trading (a buyout, a delisting)
// is still valued at its final price instead of dropping to zero.
export async function rememberPrices(sql, qs) {
  const rows = Object.entries(qs).map(([sym, q]) => ({ sym, px: q.p || q }));
  if (!rows.length) return;
  await sql`insert into symbols ${sql(rows.map(r => ({ sym: r.sym, last_px: r.px, last_at: new Date() })), 'sym', 'last_px', 'last_at')}
            on conflict (sym) do update set last_px = excluded.last_px, last_at = excluded.last_at`;
}

export async function lastPrices(sql, syms) {
  if (!syms.length) return {};
  const rows = await sql`select sym, last_px from symbols where sym = any(${syms}) and last_px is not null`;
  return Object.fromEntries(rows.map(r => [r.sym, r.last_px]));
}

/* ---------- test prices (MARKET_MOCK=1 only) ---------- */
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function mockBase(sym) { return sym === 'SPY' ? 560 : BOND.has(sym) ? 70 + hash(sym) % 40 : 20 + hash(sym) % 480; }
function mockAt(sym, day, minute) {
  const split = (process.env.MOCK_SPLITS || '').split(',').map(x => x.split(':')).find(([s, dd]) => s === sym && dd <= day);
  const b = mockBase(sym) / (split ? Number(split[2]) : 1), h = hash(sym + day);
  const dayMove = 1 + ((h % 401) - 200) / 10000;                       // up to ±2% a day
  const intra = 1 + Math.sin((minute + hash(sym) % 97) / 37) * 0.004;  // a little wiggle during the day
  const dayIdx = Math.floor(Date.parse(day + 'T12:00:00Z') / 86400000);
  const trend = 1 + ((hash(sym) % 7) - 3) * 0.0006 * (dayIdx % 100);
  return +(b * dayMove * intra * trend).toFixed(2);
}
function mockQuotes(list) {
  const d = today(), m = Math.floor(Date.now() / 60000), prev = addDays(d, -1), out = {};
  for (const s of list) out[s] = { p: mockAt(s, d, m + (Number(process.env.MOCK_SHIFT) || 0)), pc: mockAt(s, prev, 0), u: Date.now() };
  return out;
}
function mockCloses(date) {
  return new Proxy({}, { get: (_, s) => typeof s === 'string' && TICKER.test(s) ? mockAt(s, date, 0) : undefined, has: (_, s) => TICKER.test(String(s)) });
}
function mockDividends(date) {
  // Pretend each bond fund pays monthly on the first weekday of the month.
  const d = new Date(date + 'T12:00:00Z');
  let first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12));
  while ([0, 6].includes(first.getUTCDay())) first = new Date(first.getTime() + 86400000);
  if (first.toISOString().slice(0, 10) !== date) return [];
  return [...BOND].slice(0, 12).map(sym => ({ sym, ex: date, pay: addDays(date, 6), amount: 0.25 }));
}
