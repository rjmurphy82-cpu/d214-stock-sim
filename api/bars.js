// GET /api/bars?ticker=AAPL
// Five years of split-adjusted daily bars for the price chart: [date, open, high, low, close, volume].
import { TICKER, param, massive, cached, send, fail, nyDate, round } from './_massive.js';

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
  const now = Date.now();
  const to = nyDate(now);
  const from = nyDate(now - (5 * 365 + 10) * 86400000);
  try {
    const data = await cached(`bars:${ticker}:${to}`, 15 * 60000, () =>
      massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: 50000 }));
    const bars = (data.results || []).map(b => [nyDate(b.t), round(b.o), round(b.h), round(b.l), round(b.c), Math.round(b.v || 0)]);
    send(res, 200, { ticker, bars }, 900);
  } catch (e) {
    fail(res, e);
  }
}
