# Launch setup (about 20 minutes)

Everything happens in the Vercel dashboard for the `d214-stock-sim` project, then in the site's Admin page.

## 1. Add the database

1. Vercel project → **Storage** → **Create Database** → **Neon (Postgres)**. Pick the free plan and the region closest to Chicago (US East).
2. Connect it to the project for **Production** (and Preview if you want to test there too).
   This adds `DATABASE_URL` automatically. The app creates its tables the first time it runs.

## 2. Add four environment variables

Project → **Settings → Environment Variables** (check Production and Preview):

| Name | Value |
| --- | --- |
| `MASSIVE_API_KEY` | from massive.com/dashboard/keys (may already be set) |
| `SESSION_SECRET` | any random string of 32+ characters. One way: a password manager's generator, 40 characters |
| `ADMIN_PASSWORD` | the district admin password. Long and private: it can see and reset everyone |
| `CRON_SECRET` | another random string of 32+ characters (Vercel uses it to run the end-of-day job) |

Then **Deployments → latest → Redeploy**.

## 3. Load the roster

1. Build the master spreadsheet with exactly these columns (see `roster-template.csv`):
   `School, Teacher, Period, First Name, Last Name`
   School can be written loosely ("John Hersey High School", "BGHS"). Period can be "2", "P2", or "Period 2".
2. Open the site → **District admin sign-in** → Admin page → **Roster**.
3. Paste the rows (or choose the CSV file) → **Preview** → check the warnings → **Import**.
4. **Print login slips right away.** Passwords are shown only once (teachers can reset any of them later).
   One page per class: the teacher's own sign-in at the top, cut-apart slips for each student below.

Only first names and the shortest last-name piece that keeps classmates apart are saved ("Jack M.", or "Jack Ma." and "Jack Mi."). Full last names are never stored. Re-importing an updated sheet only adds new students.

## 4. Test, then start fresh

1. Sign in as a student from a slip and make a trade while the market is open.
2. Check that a teacher sign-in shows their classes.
3. When you're ready for students: Admin → **Start the competition over** (type RESET). Everyone goes back to $100,000 and the S&P 500 comparison starts that moment.

## How the game runs

- **Trades** go through only while the market is open (8:30 AM to 3:00 PM Central), at the live Massive price, checked on the server.
- **End of day** runs automatically each weekday around 6:30 PM Central: money market interest, dividends and bond interest (real amounts from Massive), stock splits, auto-invest buys at the closing price, each student's closing value, and the awards. If a day is missed it catches up on the next run, or use **Run end of day now** on the Admin page.
- **Awards** reward results and patience: Trader of the Day and Best Trade of the Week (closing trades of $1,000 or more), Mover of the Day/Week, Biggest Climber, Steady Hands (no trades all week and still up). There is no award for trading the most.
- **Rules you can change** on the Admin page: money market rate, minimum price to buy ($1) and to short ($5), and a switch to pause all trading.

## Privacy notes

- Students sign in by picking school, teacher, class, and name, then a password. The name list is visible to anyone who opens the site and picks a teacher; it shows only first names and last initials.
- Sessions are signed, HttpOnly cookies. Resetting a password signs that person out everywhere.
- Students see classmates' holdings as percentages and values only; teachers see full detail for their own students; the admin sees everyone.
- Nothing is stored in the browser except the last school picked on the sign-in screen.

## Running it locally (optional)

```
DATABASE_URL=postgres://... LOCAL_DEV=1 MARKET_MOCK=1 ADMIN_PASSWORD=test ALLOW_CLOSED_TRADES=1 node scripts/dev-server.js
```
`MARKET_MOCK=1` uses made-up prices. `npm test` (with the server running and `ADMIN_PASSWORD` set) checks sign-in, trades, standings, teacher tools, and end of day. `node scripts/test-eod.js` and `node scripts/seed-test.js` need an empty test database.
