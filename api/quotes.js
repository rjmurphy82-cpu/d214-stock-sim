// GET /api/quotes?tickers=AAPL,NVDA,SPY
// Latest price, previous close, and today's bar for each ticker (Massive snapshot).
import { TICKER, param, massive, cached, send, fail, toMs, nyDate, round } from './_massive.js';

export default async function handler(req, res) {
  const list = [...new Set(param(req, 'tickers').toUpperCase().split(',').map(s => s.trim()).filter(s => TICKER.test(s)))]
    .sort().slice(0, 100);
  if (!list.length) return send(res, 400, { error: 'Pass one or more tickers.' });
  try {
    const joined = list.join(',');
    const data = await cached('snap:' + joined, 20000, () =>
      massive('/v2/snapshot/locale/us/markets/stocks/tickers', { tickers: joined }));
    const quotes = {};
    let asOf = 0;
    for (const t of data.tickers || []) {
      const pc = t.prevDay && t.prevDay.c > 0 ? t.prevDay.c : null;
      const price = [t.lastTrade && t.lastTrade.p, t.min && t.min.c, t.day && t.day.c, pc].find(v => typeof v === 'number' && v > 0);
      if (!price) continue;
      const u = toMs(t.updated) || toMs(t.min && t.min.t) || 0;
      if (u > asOf) asOf = u;
      const d = t.day && t.day.c > 0 && u
        ? { d: nyDate(u), o: round(t.day.o), h: round(t.day.h), l: round(t.day.l), c: round(t.day.c), v: Math.round(t.day.v || 0) }
        : null;
      quotes[t.ticker] = { p: round(price), pc: round(pc), day: d, u };
    }
    send(res, 200, { asOf, quotes }, 20);
  } catch (e) {
    fail(res, e);
  }
}
