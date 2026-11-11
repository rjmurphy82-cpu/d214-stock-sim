// GET /api/news
// Big-picture market news only: stories Massive tags to whole-market funds (S&P 500, Nasdaq, Dow, small caps)
// or to one of the 11 sector funds. Company press releases are dropped. Cached 10 minutes.
import { massive, cached, send, fail } from './_massive.js';

const FUNDS = {
  SPY: 'Market', DIA: 'Market', QQQ: 'Market', IWM: 'Small Companies',
  XLK: 'Tech', XLF: 'Banks & Finance', XLE: 'Energy', XLV: 'Health Care', XLY: 'Shopping & Travel',
  XLP: 'Everyday Goods', XLI: 'Industry', XLB: 'Materials', XLU: 'Utilities', XLRE: 'Real Estate', XLC: 'Media & Telecom'
};
const PRESS_RELEASES = /globe ?newswire|pr ?newswire|business ?wire|accesswire|newsfile|access newswire|einpresswire/i;
// Promo pieces about a single fund or stock ("Should XYZ ETF Be on Your Radar?", "1 Stock to Buy").
const PROMO = /\([A-Z]{1,5}\)|on your (investing )?radar|right now\?|worth a look|\bto buy\b|\bbuy now\b|should you buy|\bstrong (etf|stock|buy)\b|\bstocks? (to|that)\b|dividend (king|stock)|\bmillionaire|\bretire|\b\d+ (stocks?|etfs?|funds?)\b|\byield investors\b|\bzacks rank\b|smart beta|no-brainer|unstoppable|million|loading up|\bi'?m\b|\bmy\b|costly mistake|could (build|make|soar|double)|here's how|forever|passive income|dividend|\b\d+ ([\w-]+ ){0,2}(stocks?|etfs?|funds?|mistakes?|reasons?|ways?)\b/i;
// Big-picture words: the economy, the Fed, rates, prices, jobs, the overall market, whole sectors, trade, energy.
const MACRO = /\bfed\b|federal reserve|powell|interest rate|rate (cut|hike)|inflation|\bcpi\b|\bppi\b|\bjobs?\b|payroll|unemployment|labor|economy|economic|\bgdp\b|recession|consumer|retail sales|spending|housing|mortgage|treasur|yields?\b|bond|tariff|trade|china|oil|crude|opec|gas prices|energy|wall street|stock market|markets?\b|s&p|\bdow\b|nasdaq|rally|sell-?off|earnings season|sector|banks?\b|\bai\b|chip|tech stocks|dollar|gold|shutdown|congress|white house|election/i;
const MOODS = { positive: 'good', negative: 'bad', neutral: 'neutral' };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

export default async function handler(req, res) {
  try {
    const out = await cached('news:broad', 10 * 60000, async () => {
      const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const pulls = await Promise.allSettled(Object.keys(FUNDS).map(t =>
        massive('/v2/reference/news', { ticker: t, 'published_utc.gte': since, order: 'desc', sort: 'published_utc', limit: 40 }).then(r => ({ t, r }))));
      if (!pulls.some(p => p.status === 'fulfilled')) throw pulls[0].reason;
      const byKey = new Map();
      for (const p of pulls) {
        if (p.status !== 'fulfilled') continue;
        const fund = p.value.t;
        for (const a of p.value.r.results || []) {
          const pub = (a.publisher && a.publisher.name) || '';
          const title = clip(a.title, 150);
          if (!title || PRESS_RELEASES.test(pub) || PRESS_RELEASES.test(a.article_url || '')) continue;
          if (PROMO.test(title) || !MACRO.test(title)) continue;
          const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const prev = byKey.get(key);
          // A story tagged to a sector fund gets that sector's label over a general "Market" label.
          if (prev && !(FUNDS[prev.fund] === 'Market' && FUNDS[fund] !== 'Market')) continue;
          const ins = (a.insights || []).find(i => i.ticker === fund) || null;
          byKey.set(key, {
            fund, tag: FUNDS[fund], title, summary: clip(a.description, 200), source: clip(pub, 50), at: a.published_utc || '',
            mood: ins ? (MOODS[ins.sentiment] || 'neutral') : null, why: ''
          });
        }
      }
      // Newest first, but no more than 3 stories from any one sector so the panel stays broad.
      const per = {}, items = [];
      for (const n of [...byKey.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
        if ((per[n.tag] = (per[n.tag] || 0) + 1) > 3) continue;
        items.push(n);
        if (items.length >= 14) break;
      }
      return { items };
    });
    send(res, 200, out, 600);
  } catch (e) {
    if (e && /plan/.test(e.message || '')) return send(res, 200, { items: [], unavailable: 'plan' }, 3600);
    fail(res, e);
  }
}
