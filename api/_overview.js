// Ticker Overview from Massive, cached for a day. Shared by /api/ticker and /api/logo.
import { massive, cached } from './_massive.js';

export function overview(ticker) {
  return cached('ov:' + ticker, 86400000, async () => {
    const data = await massive('/v3/reference/tickers/' + encodeURIComponent(ticker));
    return data.results || {};
  });
}
