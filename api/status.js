// GET /api/status
// Is the U.S. stock market open right now? The page also uses this to decide whether live data is set up.
// It also sends today's (or the next) trading session and the server's clock, so the page can unlock and
// lock the Trade screen right at 8:30 and 3:00 Central, using the server's time instead of the laptop's.
// Never cached: a stale "pre-market" answer is what used to keep trading locked after the open.
import { send, fail } from './_massive.js';
import { marketNow } from '../lib/market.js';

export default async function handler(req, res) {
  try {
    const s = await marketNow();
    send(res, 200, {
      market: s.market,                 // "open", "closed", or "extended-hours"
      early: s.early,
      after: s.after,
      session: s.session,               // {date, open, close} as timestamps, or null
      serverTime: s.serverTime
    });
  } catch (e) {
    fail(res, e);
  }
}
