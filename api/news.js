// GET /api/news?ticker=AAPL
// Recent news stories about one company from Massive's news feed, newest first.
// Massive tags each story with the companies it is about and whether it reads as good,
// bad, or neutral for each one, plus a one-sentence reason. We pass along only what the
// News tab shows. Cached 15 minutes so every student looking at the same stock shares one call.
import { TICKER, param, massive, cached, send, fail } from './_massive.js';

const MOODS = { positive: 'good', negative: 'bad', neutral: 'neutral' };
const okUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : '';
const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
};

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
  try {
    const out = await cached('news:' + ticker, 15 * 60000, async () => {
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const r = await massive('/v2/reference/news', {
        ticker, 'published_utc.gte': since, order: 'desc', sort: 'published_utc', limit: 20
      });
      const seen = new Set();
      const items = [];
      for (const a of r.results || []) {
        const title = clip(a.title, 200);
        const key = title.toLowerCase();
        if (!title || seen.has(key)) continue;        // the same story often comes from two outlets
        seen.add(key);
        const ins = (a.insights || []).find(i => i && i.ticker === ticker) || null;
        items.push({
          title,
          summary: clip(a.description, 320),
          source: clip(a.publisher && a.publisher.name, 60),
          url: okUrl(a.article_url),
          at: a.published_utc || '',
          mood: ins ? (MOODS[ins.sentiment] || 'neutral') : null,
          why: ins ? clip(ins.sentiment_reasoning, 260) : '',
          // stories that only mention this company in passing tag many tickers
          others: Math.max(0, (a.tickers || []).length - 1)
        });
        if (items.length >= 12) break;
      }
      return { ticker, items };
    });
    send(res, 200, out, 900);
  } catch (e) {
    // Massive answers 401/403 when the plan doesn't include the news feed.
    if (e && /plan/.test(e.message || '')) return send(res, 200, { ticker, items: [], unavailable: 'plan' }, 3600);
    if (e && e.status === 404) return send(res, 200, { ticker, items: [] }, 900);
    fail(res, e);
  }
}
