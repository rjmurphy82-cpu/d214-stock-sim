# D214 Investing Competition (demo)

A working demo of the District 214 stock market simulation. Students and classmates are samples, and each visitor's trades are saved only in their own browser.

Pages: My Portfolio, Standings, Checkup, Charts, Trade.

## Live market data from Massive

When the Massive API key is set up, the demo uses real prices from Massive.com. Without it, the page runs exactly as before on sample prices.

### Turn it on (one time, in Vercel)

1. Open the project in Vercel, then **Settings → Environment Variables**.
2. Add `MASSIVE_API_KEY` with the key from https://massive.com/dashboard/keys. Check **Production** and **Preview**.
3. Redeploy (Deployments → the latest one → Redeploy).

The key stays on the server. The browser only ever talks to this site's own `/api` functions.

### What's live and what's still sample

| Live from Massive | Still sample |
| --- | --- |
| Prices and today's change (refreshed every minute) | Classmates, classes, teachers, schools |
| Price charts (5 years of daily bars, split-adjusted) | P/E, dividend yield, revenue growth |
| Search for any U.S. stock or ETF | Financial statements on the Charts page |
| Company logos | Dividends and bond interest amounts |
| Market cap, industry, company description | Earnings dates |
| Market open or closed | |

The first time real prices load, the sample portfolio is converted so each holding keeps the same dollar value and percent gain. Share counts and cost basis change to match real prices.

### Server functions (`/api`)

| Endpoint | What it returns | Massive endpoint |
| --- | --- | --- |
| `/api/status` | Market open, closed, or extended hours | `GET /v1/marketstatus/now` |
| `/api/quotes?tickers=A,B` | Price, previous close, today's bar | `GET /v2/snapshot/locale/us/markets/stocks/tickers` |
| `/api/bars?ticker=A` | Five years of daily bars | `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}` |
| `/api/search?q=text` | Matching stocks and ETFs | `GET /v3/reference/tickers` |
| `/api/ticker?ticker=A` | Name, industry, description, market cap | `GET /v3/reference/tickers/{ticker}` |
| `/api/logo?ticker=A` | Company icon image | branding image from Ticker Overview |

Each function caches its answer (20 seconds for prices, up to a day for company info), and Vercel's CDN shares that answer across every visitor. Students don't each make their own Massive calls.

## Attribution (required)

The Massive order form requires "Market Data Source: Massive.com", linked to https://massive.com, to be visible on every page that shows Massive data. The bar at the bottom of the screen does this on every page and stays on screen while scrolling. Massive has final approval over its form, placement, and prominence, so get their sign-off before launch and don't remove or hide the bar.

In demo mode (no key) the bar says the prices are samples instead, since sample prices must never carry Massive's name.

## Files

- `index.html`: the whole app (Vercel serves it as is, no build step)
- `api/`: Vercel functions for Massive data (Node 18 or newer)
- `logos/`: school logos
