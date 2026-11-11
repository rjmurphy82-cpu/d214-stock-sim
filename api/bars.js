// GET /api/bars?ticker=SPY
// Today's regular-session 5-minute closes, for the small trend line under each index.
import { TICKER, param, massive, cached, send, fail, nyDate, round } from './_massive.js';

const nyMin = ms => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value; };

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
  const now = Date.now(), to = nyDate(now), from = nyDate(now - 7 * 86400000);
  try {
    const data = await cached(`intra:${ticker}:${Math.floor(now / 60000)}`, 60000, () =>
      massive(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/5/minute/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: 50000 }));
    let bars = (data.results || []).filter(b => { const m = nyMin(b.t); return m >= 570 && m < 960; }).map(b => [b.t, round(b.c)]);
    const last = bars.length ? nyDate(bars[bars.length - 1][0]) : null;     // the latest trading day only
    bars = bars.filter(b => nyDate(b[0]) === last);
    send(res, 200, { ticker, bars }, 60);
  } catch (e) {
    fail(res, e);
  }
}
