// GET /api/status
// Is the U.S. stock market open right now? The page also uses this to decide whether live data is set up.
import { massive, cached, send, fail } from './_massive.js';

export default async function handler(req, res) {
  try {
    const s = await cached('status', 60000, () => massive('/v1/marketstatus/now'));
    send(res, 200, {
      market: s.market || 'unknown',          // "open", "closed", or "extended-hours"
      early: !!s.earlyHours,
      after: !!s.afterHours,
      serverTime: s.serverTime || null
    }, 60);
  } catch (e) {
    fail(res, e);
  }
}
