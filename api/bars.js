// GET /api/bars?ticker=AAPL
// All the split-adjusted daily history Massive has (back to 1980) for the price chart: [date, open, high, low, close, volume].
// If the plan won't serve that far back, it falls back to five years.
// GET /api/bars?ticker=AAPL&range=1d|1w instead returns regular-session intraday bars for the 1D chart (5-minute,
// latest session) or 1W chart (15-minute, last five sessions): [ms, open, high, low, close, volume].
import { TICKER, param, massive, cached, send, fail, nyDate, round } from './_massive.js';

const nyMin = ms => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value; };

async function intraday(res, ticker, range) {
  const now = Date.now(), to = nyDate(now), from = nyDate(now - 12 * 86400000), step = range === '1w' ? 15 : 5;
  try {
    const data = await cached(`intra:${ticker}:${range}:${Math.floor(now / 60000)}`, 60000, () =>
      massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${step}/minute/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: 50000 }));
    let bars = (data.results || []).filter(b => { const m = nyMin(b.t); return m >= 570 && m < 960; })   // 9:30 AM to 4:00 PM Eastern
      .map(b => [b.t, round(b.o), round(b.h), round(b.l), round(b.c), Math.round(b.v || 0)]);
    const days = [...new Set(bars.map(b => nyDate(b[0])))].slice(range === '1w' ? -5 : -1);
    bars = bars.filter(b => days.includes(nyDate(b[0])));
    send(res, 200, { ticker, range, step, bars }, 60);
  } catch (e) {
    fail(res, e);
  }
}

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
  const range = param(req, 'range');
  if (range === '1d' || range === '1w') return intraday(res, ticker, range);
  const now = Date.now();
  const to = nyDate(now);
  const five = nyDate(now - (5 * 365 + 10) * 86400000);
  const get = from => massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: 50000 });
  try {
    const data = await cached(`bars:${ticker}:${to}:max`, 15 * 60000, async () => {
      try {
        const all = await get('1980-01-01');
        if (all.results && all.results.length) return all;
      } catch (e) { if (e.status === 404) throw e; }
      return get(five);
    });
    const bars = (data.results || []).map(b => [nyDate(b.t), round(b.o), round(b.h), round(b.l), round(b.c), Math.round(b.v || 0)]);
    send(res, 200, { ticker, bars }, 900);
  } catch (e) {
    fail(res, e);
  }
}
