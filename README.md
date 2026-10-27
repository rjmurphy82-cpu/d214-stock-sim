# D214 Investing Competition

The District 214 stock market simulation: 12 teachers, 6 schools, about 300 students, live prices from Massive.

**To launch, follow [SETUP.md](SETUP.md).**

Student pages: My Portfolio, Standings, Checkup, Charts, Trade. Teachers get My Classes; the district admin gets an Admin page (roster import, login slips, game settings, end of day).

Every portfolio lives in a Postgres database (Neon on Vercel). Trades, the money market, auto-invest, dividends, splits, standings, and awards all run on the server; the page only displays them.

## Live market data from Massive

When the Massive API key is set up, the demo uses real prices from Massive.com. Without it, the page runs exactly as before on sample prices.

### Turn it on (one time, in Vercel)

1. Open the project in Vercel, then **Settings → Environment Variables**.
2. Add `MASSIVE_API_KEY` with the key from https://massive.com/dashboard/keys. Check **Production** and **Preview**.
3. Redeploy (Deployments → the latest one → Redeploy).

The key stays on the server. The browser only ever talks to this site's own `/api` functions.

### What's live and what's still sample

Everything shown is real Massive data: prices for every trade, portfolio, and standing; 5-year price charts; search; dividends, bond interest, yields, and splits; logos, market cap, industry, and descriptions; market hours, holidays, and closing prices; and each company's last five annual reports (income statement, balance sheet, ratios, P/E, revenue growth).

Expense ratios and holding counts for about a dozen common ETFs are typed in by hand and approximate. Earnings dates are not shown.

Company financials need Massive's Financials & Ratios data (included in Stocks Advanced, or as an add-on). Without it, the Financials tab says so instead of showing numbers.

### Server functions (`/api`)

| Endpoint | What it returns | Massive endpoint |
| --- | --- | --- |
| `/api/status` | Market open, closed, or extended hours | `GET /v1/marketstatus/now` |
| `/api/quotes?tickers=A,B` | Price, previous close, today's bar | `GET /v2/snapshot/locale/us/markets/stocks/tickers` |
| `/api/bars?ticker=A` | Five years of daily bars | `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}` |
| `/api/search?q=text` | Matching stocks and ETFs | `GET /v3/reference/tickers` |
| `/api/ticker?ticker=A` | Name, industry, description, market cap | `GET /v3/reference/tickers/{ticker}` |
| `/api/logo?ticker=A` | Company icon image | branding image from Ticker Overview |
| `/api/fin?ticker=A` | Last 5 annual income statements and balance sheets, plus ratios | `GET /stocks/financials/v1/income-statements`, `/balance-sheets`, `/ratios` |

Each function caches its answer (20 seconds for prices, up to a day for company info), and Vercel's CDN shares that answer across every visitor. Students don't each make their own Massive calls.

## Attribution (required)

The Massive order form requires "Market Data Source: Massive.com", linked to https://massive.com, to be visible on every page that shows Massive data. The bar at the bottom of the screen does this on every page and stays on screen while scrolling. Massive has final approval over its form, placement, and prominence, so get their sign-off before launch and don't remove or hide the bar.

In demo mode (no key) the bar says the prices are samples instead, since sample prices must never carry Massive's name.

## Files

- `index.html`: the whole app (Vercel serves it as is, no build step)
- `api/app.js`: sign-in, portfolio, trades, standings, teacher and admin tools (`/api/app?fn=...`)
- `api/cron.js`: the end-of-day job (scheduled in `vercel.json`)
- `api/` other files: Massive pass-through for prices, charts, search, logos
- `lib/`: database schema, game rules (`portfolio.js`), standings, end of day (`eod.js`), roster import, sign-in
- `scripts/`: local dev server and tests
- `logos/`: school logos
