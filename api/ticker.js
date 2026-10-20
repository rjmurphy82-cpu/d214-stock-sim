// GET /api/ticker?ticker=AAPL
// Company name, industry, a one-sentence description, and market cap.
import { TICKER, param, send, fail } from './_massive.js';
import { overview } from './_overview.js';

const KIND = { CS: 'stock', ADRC: 'stock', ETF: 'etf', ETN: 'etf', ETV: 'etf' };

function titleCase(s) {
  return (s || '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(And|Of|The|For|In)\b/g, w => w.toLowerCase());
}
function firstSentence(s) {
  if (!s) return '';
  const m = s.match(/^.{20,240}?[.!?](\s|$)/);
  return (m ? m[0] : s.slice(0, 200) + (s.length > 200 ? '…' : '')).trim();
}

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
  try {
    const r = await overview(ticker);
    send(res, 200, {
      s: r.ticker || ticker,
      n: r.name || ticker,
      k: KIND[r.type] || 'stock',
      sector: titleCase(r.sic_description),
      about: firstSentence(r.description),
      cap: typeof r.market_cap === 'number' ? r.market_cap : null,
      logo: !!(r.branding && (r.branding.icon_url || r.branding.logo_url))
    }, 86400);
  } catch (e) {
    fail(res, e);
  }
}
