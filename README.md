# D214 Market Board (hallway TV)

A separate site from the stock sim. Full-screen 1920x1080 board:

- Scrolling prices for the 25 largest US stocks, major indices (via SPY, DIA, QQQ, IWM), and market news, all from Massive (`/api/quotes`, `/api/bars`, `/api/news`, `/api/status`).
- A school's top 10, awards, and class battle, read from the stock sim (`/api/board` calls the sim's read-only `fn=tv` route).

Open: `https://<this site>/?school=rolling-meadows&key=TV_KEY`

## Settings (Vercel → this project → Environment Variables)

- `MASSIVE_API_KEY`: the Massive key (same one the sim uses).
- `SIM_URL`: `https://d214-stock-sim.vercel.app` (already set).

The TV key itself is set only in the **stock sim** project as `TV_KEY`. This site just passes it along.

"Market Data Source: Massive.com" is shown in the header, as the Massive order form requires.
