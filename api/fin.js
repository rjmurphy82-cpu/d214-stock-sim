// GET /api/fin?ticker=AAPL
// Up to ten fiscal years from the company's annual reports (10-K filings), the last twelve quarters
// (10-Q filings, for the 1-year ratio trend), plus Massive's latest ratios. Statement figures are in U.S. dollars. Updated by Massive once a day.
import { TICKER, param, massive, cached, send, fail } from './_massive.js';

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

export default async function handler(req, res) {
  const ticker = param(req, 'ticker').toUpperCase();
  if (!TICKER.test(ticker)) return send(res, 400, { error: 'Pass a ticker.' });
  try {
    const out = await cached('fin2:' + ticker, 6 * 3600000, async () => {
      const q = { tickers: ticker, timeframe: 'annual', sort: 'period_end.desc', limit: 10 };
      const qq = { tickers: ticker, timeframe: 'quarterly', sort: 'period_end.desc', limit: 12 };
      const none = () => ({ results: [] });
      const [inc, bal, rat, qinc, qbal] = await Promise.all([
        massive('/stocks/financials/v1/income-statements', q),
        massive('/stocks/financials/v1/balance-sheets', q),
        massive('/stocks/financials/v1/ratios', { ticker, limit: 1 }).catch(none),
        massive('/stocks/financials/v1/income-statements', qq).catch(none),
        massive('/stocks/financials/v1/balance-sheets', qq).catch(none)
      ]);
      const incRow = r => ({
        fy: r.fiscal_year, fq: r.fiscal_quarter ?? null, end: r.period_end,
        rev: num(r.revenue), cogs: num(r.cost_of_revenue), gp: num(r.gross_profit), op: num(r.operating_income),
        ni: num(r.net_income_loss_attributable_common_shareholders) ?? num(r.consolidated_net_income_loss),
        eps: num(r.diluted_earnings_per_share) ?? num(r.basic_earnings_per_share)
      });
      const balRow = r => {
        const debt = (num(r.debt_current) || 0) + (num(r.long_term_debt_and_capital_lease_obligations) || 0);
        return {
          fy: r.fiscal_year, fq: r.fiscal_quarter ?? null, end: r.period_end,
          assets: num(r.total_assets), liab: num(r.total_liabilities),
          equity: num(r.total_equity_attributable_to_parent) ?? num(r.total_equity),
          ca: num(r.total_current_assets), cl: num(r.total_current_liabilities),
          cash: num(r.cash_and_equivalents), debt
        };
      };
      const incs = res => (res.results || []).filter(r => num(r.revenue) !== null).map(incRow).reverse();
      const bals = res => (res.results || []).filter(r => num(r.total_assets) !== null).map(balRow).reverse();
      const income = incs(inc), balance = bals(bal), qIncome = incs(qinc), qBalance = bals(qbal);
      const r = (rat.results || [])[0] || null;
      const ratios = r && { date: r.date, pe: num(r.price_to_earnings), eps: num(r.earnings_per_share), cap: num(r.market_cap) };
      return { ticker, income, balance, qIncome, qBalance, ratios };
    });
    send(res, 200, out, 21600);
  } catch (e) {
    // Massive answers 401/403 when the plan doesn't include financials.
    if (e && /plan/.test(e.message || '')) return send(res, 200, { ticker, income: [], balance: [], ratios: null, unavailable: 'plan' }, 3600);
    if (e && e.status === 404) return send(res, 200, { ticker, income: [], balance: [], ratios: null }, 3600);
    fail(res, e);
  }
}
