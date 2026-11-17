// GET /api/bars?ticker=AAPL
// All the split-adjusted daily history Massive has (back to 1980) for the price chart: [date, open, high, low, close, volume].
// If the plan won't serve that far back, it falls back to five years.
// GET /api/bars?ticker=AAPL&range=1d|1w instead returns regular-session intraday bars for the 1D chart (5-minute,
// latest session) or 1W chart (15-minute, last five sessions): [ms, open, high, low, close, volume].
// Add &ext=1 for pre-market and after-hours too, plus one extra day: [ms, open, high, low, close, volume, session]
// where session is 0 pre-market, 1 regular, 2 after-hours. Extended hours are for the chart only; nobody trades on them.
import { TICKER, param, massive, cached, send, fail, nyDate, round } from './_massive.js';
import { sessionOfBar, warmCalendar } from '../lib/market.js';

async function intraday(res, ticker, range, ext) {
  const now = Date.now(), to = nyDate(now), from = nyDate(now - 12 * 86400000), step = range === '1w' ? 15 : 5;
  try {
    await warmCalendar();
    const data = await cached(`intra:${ticker}:${range}:${Math.floor(now / 60000)}`, 60000, () =>
      massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${step}/minute/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: 50000 }));
    let bars = (data.results || []).map(b => [b.t, round(b.o), round(b.h), round(b.l), round(b.c), Math.round(b.v || 0), sessionOfBar(b.t)])
      .filter(b => ext ? b[6] >= 0 : b[6] === 1);   // 4:00 AM to 8:00 PM Eastern, or just 9:30 AM to 4:00 PM
    if (!ext) bars = bars.map(b => b.slice(0, 6));
    // With ext, one extra day, so the page can still show the last full regular session early in the morning
    // (when today has only pre-market bars) if a student turns extended hours off.
    const days = [...new Set(bars.map(b => nyDate(b[0])))].slice((range === '1w' ? -5 : -1) - (ext ? 1 : 0));
    bars = bars.filter(b => days.includes(nyDate(b[0])));
    send(res, 200, { ticker, range, step, ext, bars }, 60);
  } catch (e) {
    fail(res, e);
  }
}

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
  const range = param(req, 'range');
  if (range === '1d' || range === '1w') return intraday(res, ticker, range, param(req, 'ext') === '1');
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
