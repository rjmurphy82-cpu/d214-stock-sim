// GET /api/logo?ticker=AAPL
// The company's icon from Massive. Massive's image links need the API key,
// so the server fetches the image and passes it through without exposing the key.
import { TICKER, param, massiveFile, cached, fail } from './_massive.js';
import { overview } from './_overview.js';

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) { res.statusCode = 400; return res.end(); }
  try {
    const r = await overview(ticker);
    const src = r.branding && (r.branding.icon_url || r.branding.logo_url);
    if (!src) { res.statusCode = 404; res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400'); return res.end(); }
    const img = await cached('logo:' + src, 86400000, () => massiveFile(src));
    res.statusCode = 200;
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    // Logos are third-party files: never let one run as a page on this site.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(img.body);
  } catch (e) {
    if (e && e.status === 404) { res.statusCode = 404; return res.end(); }
    fail(res, e);
  }
}
