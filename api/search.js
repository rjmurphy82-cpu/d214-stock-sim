// GET /api/search?q=netflix
// Search every active U.S. stock and ETF by ticker or company name.
import { param, massive, cached, send, fail } from './_massive.js';

const KIND = { CS: 'stock', ADRC: 'stock', ETF: 'etf', ETN: 'etf', ETV: 'etf' };

export default async function handler(req, res) {
  const q = param(req, 'q').replace(/[^\w .&'\-]/g, '').slice(0, 40);
  if (!q) return send(res, 200, { results: [] }, 3600);
  try {
    const up = q.toUpperCase();
    // Massive's name search matches inside words, so "IONS" also hits every "Solutions" company and
    // "ONDS" hits every "Bonds" fund. The real ticker can fall outside the 50 results we get back,
    // so when the text could be a ticker, look that exact ticker up too and put it first.
    const exact = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(up)
      ? cached('exact:' + up, 3600000, () => massive('/v3/reference/tickers', { ticker: up, market: 'stocks', active: 'true', limit: 1 })).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] });
    const [data, hit] = await Promise.all([
      cached('search:' + q.toLowerCase(), 3600000, () =>
        massive('/v3/reference/tickers', { search: q, market: 'stocks', active: 'true', limit: 50 })),
      exact
    ]);
    const seen = new Set();
    const results = [...(hit.results || []), ...(data.results || [])]
      .filter(r => KIND[r.type] && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(r.ticker) && !seen.has(r.ticker) && seen.add(r.ticker))
      .map(r => ({ s: r.ticker, n: r.name, k: KIND[r.type] }))
      .sort((a, b) => (b.s === up) - (a.s === up) || (b.s.startsWith(up)) - (a.s.startsWith(up)) || a.s.length - b.s.length)
      .slice(0, 12);
    send(res, 200, { results }, 3600);
  } catch (e) {
    fail(res, e);
  }
}
