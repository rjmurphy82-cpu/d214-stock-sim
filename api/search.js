// GET /api/search?q=netflix
// Search every active U.S. stock and ETF by ticker or company name.
import { param, massive, cached, send, fail } from './_massive.js';

const KIND = { CS: 'stock', ADRC: 'stock', ETF: 'etf', ETN: 'etf', ETV: 'etf' };

export default async function handler(req, res) {
  const q = param(req, 'q').replace(/[^\w .&'\-]/g, '').slice(0, 40);
  if (!q) return send(res, 200, { results: [] }, 3600);
  try {
    const data = await cached('search:' + q.toLowerCase(), 3600000, () =>
      massive('/v3/reference/tickers', { search: q, market: 'stocks', active: 'true', limit: 50 }));
    const up = q.toUpperCase();
    const results = (data.results || [])
      .filter(r => KIND[r.type] && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(r.ticker))
      .map(r => ({ s: r.ticker, n: r.name, k: KIND[r.type] }))
      .sort((a, b) => (b.s === up) - (a.s === up) || (b.s.startsWith(up)) - (a.s.startsWith(up)) || a.s.length - b.s.length)
      .slice(0, 12);
    send(res, 200, { results }, 3600);
  } catch (e) {
    fail(res, e);
  }
}
