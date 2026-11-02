// GET /api/bars?ticker=AAPL
// All the split-adjusted daily history Massive has (back to 1980) for the price chart: [date, open, high, low, close, volume].
// If the plan won't serve that far back, it falls back to five years.
import { TICKER, param, massive, cached, send, fail, nyDate, round } from './_massive.js';

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
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
