// Local stand-in for Vercel: serves index.html and the logos, and runs /api/<name> with api/<name>.js.
// Usage: DATABASE_URL=postgres://... LOCAL_DEV=1 MARKET_MOCK=1 ADMIN_PASSWORD=... node scripts/dev-server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3214);
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv' };

// With MARKET_MOCK=1 the Massive pass-through endpoints answer with test prices too.
async function mockMarket(name, url, res) {
  const M = await import('../lib/market.js');
  const json = b => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); };
  const t = (url.searchParams.get('ticker') || '').toUpperCase();
  if (name === 'status') return json({ market: process.env.MOCK_MARKET || 'open', early: false, after: false });
  if (name === 'quotes') {
    const list = (url.searchParams.get('tickers') || '').toUpperCase().split(',').filter(Boolean);
    const q = await M.quotes(list);
    return json({ asOf: Date.now(), quotes: Object.fromEntries(Object.entries(q).map(([s, v]) => [s, { p: v.p, pc: v.pc, day: null, u: v.u }])) });
  }
  if (name === 'bars') {
    const bars = [];
    for (let d = M.addDays(M.today(), -1830); d < M.today(); d = M.addDays(d, 1)) {
      if (!M.isWeekday(d)) continue;
      const c = (await M.closes(d))[t], o = (await M.closes(M.addDays(d, -1)))[t];
      bars.push([d, o, Math.max(o, c) * 1.006, Math.min(o, c) * 0.994, c, 1e6 + (c * 1000 % 5e6)]);
    }
    return json({ ticker: t, bars });
  }
  if (name === 'search') { const q = (url.searchParams.get('q') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5); return json({ results: q ? [{ s: q, n: q + ' Test Co.', k: 'stock' }] : [] }); }
  if (name === 'ticker') return json({ s: t, n: t + ' Test Co.', k: M.BOND.has(t) ? 'etf' : 'stock', sector: '', about: '', cap: null, logo: false });
  if (name === 'logo') { res.statusCode = 404; return res.end(); }
  if (name === 'news') {
    if (t === 'NONEWS') return json({ ticker: t, items: [] });
    const ago = h => new Date(Date.now() - h * 3600000).toISOString();
    return json({ ticker: t, items: [
      { title: t + ' Beats Quarterly Earnings Estimates as Revenue Jumps 18%', summary: '', source: 'Test Wire', url: 'https://example.com/a', at: ago(2), mood: 'good', why: t + ' reported revenue and profit above what analysts expected and raised its outlook for next year.', others: 0 },
      { title: 'Analyst Downgrades ' + t + ', Cuts Price Target on Valuation Worries', summary: '', source: 'Test Markets', url: 'https://example.com/b', at: ago(20), mood: 'bad', why: 'An analyst lowered the rating because the stock already trades at a high valuation.', others: 0 },
      { title: 'Stocks Rally as the Fed Holds Interest Rates Steady', summary: 'Major indexes climbed after the Federal Reserve left rates unchanged.', source: 'Test Daily', url: 'https://example.com/c', at: ago(30), mood: 'neutral', why: t + ' is mentioned as one of many large companies that rose with the market.', others: 9 },
      { title: t + ' Announces $10 Billion Share Buyback and Raises Dividend', summary: '', source: 'Test Wire', url: 'https://example.com/d', at: ago(96), mood: 'good', why: 'Returning cash to shareholders signals the company is confident about its future.', others: 0 },
      { title: 'Tariffs Could Squeeze ' + t + ' Margins, Report Says', summary: 'A new report looks at how import taxes may affect costs.', source: 'Test Journal', url: 'https://example.com/e', at: ago(200), mood: null, why: '', others: 1 }
    ] });
  }
  if (name === 'fin') {
    if (t === 'NOFIN') return json({ ticker: t, income: [], balance: [], ratios: null });
    const bank = t === 'JPM', base = 20 + (t.charCodeAt(0) % 9) * 15;
    const yrs = [2021, 2022, 2023, 2024, 2025];
    return json({ ticker: t,
      income: yrs.map((fy, i) => ({ fy, end: fy + '-09-30', rev: base * 1e9 * (1 + i * 0.08), cogs: null, gp: bank ? null : base * 0.4e9 * (1 + i * 0.08),
        op: base * 0.25e9 * (1 + i * 0.1), ni: (i === 0 ? -0.05 : 0.18) * base * 1e9 * (1 + i * 0.1), eps: i === 0 ? -0.4 : 2 + i * 0.3 })),
      balance: yrs.slice(1).map(fy => ({ fy, end: fy + '-09-30', assets: base * 3e9, liab: base * 1.8e9, equity: base * 1.2e9, ca: bank ? null : base * 0.9e9, cl: bank ? null : base * 0.7e9, cash: base * 0.3e9, debt: base * 0.6e9 })),
      ratios: { date: M.today(), pe: 24.3, eps: 3.2, cap: base * 10e9 } });
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/api\/([a-z]+)$/);
  if (m && process.env.MARKET_MOCK === '1' && ['status', 'quotes', 'bars', 'search', 'ticker', 'logo', 'fin', 'news'].includes(m[1])) return mockMarket(m[1], url, res);
  if (m) {
    const file = path.join(root, 'api', m[1] + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    try { const mod = await import(pathToFileURL(file).href); return await mod.default(req, res); }
    catch (e) { console.error(e); res.statusCode = 500; return res.end('error'); }
  }
  let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('http://localhost:' + port));
