// GET /api/news
// The latest stories across the whole market from Massive's news feed. Cached 10 minutes.
import { massive, cached, send, fail, TICKER } from './_massive.js';

const MOODS = { positive: 'good', negative: 'bad', neutral: 'neutral' };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

export default async function handler(req, res) {
  try {
    const out = await cached('news:market', 10 * 60000, async () => {
      const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      const r = await massive('/v2/reference/news', { 'published_utc.gte': since, order: 'desc', sort: 'published_utc', limit: 60 });
      const seen = new Set(), items = [];
      for (const a of r.results || []) {
        const title = clip(a.title, 160), key = title.toLowerCase();
        if (!title || seen.has(key)) continue;
        seen.add(key);
        const ins = (a.insights || [])[0] || null;
        items.push({
          title, summary: clip(a.description, 220), source: clip(a.publisher && a.publisher.name, 60), at: a.published_utc || '',
          tickers: (a.tickers || []).filter(t => TICKER.test(t)).slice(0, 3),
          mood: ins ? (MOODS[ins.sentiment] || 'neutral') : null, why: ins ? clip(ins.sentiment_reasoning, 200) : ''
        });
        if (items.length >= 16) break;
      }
      return { items };
    });
    send(res, 200, out, 600);
  } catch (e) {
    if (e && /plan/.test(e.message || '')) return send(res, 200, { items: [], unavailable: 'plan' }, 3600);
    fail(res, e);
  }
}
