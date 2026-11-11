// GET /api/economy
// Economy Snapshot from Massive's Federal Reserve data: 10-year Treasury yield, inflation, unemployment,
// job openings, and average hourly pay. Each figure is the latest reading plus the one before it. Cached 1 hour.
import { massive, cached, send, fail } from './_massive.js';

// Latest two non-empty readings of one field (newer reports can arrive before every field is filled in).
function lastTwo(rows, field) {
  const got = rows.filter(r => typeof r[field] === 'number' && isFinite(r[field]));
  return got.length ? { value: got[0][field], prev: got[1] ? got[1][field] : null, date: got[0].date } : null;
}

export default async function handler(req, res) {
  try {
    const out = await cached('economy', 60 * 60000, async () => {
      const get = path => massive(path, { sort: 'date.desc', limit: 30 }).then(r => r.results || []).catch(e => { console.warn(path, e.message); return []; });
      const [ty, inf, lab] = await Promise.all([get('/fed/v1/treasury-yields'), get('/fed/v1/inflation'), get('/fed/v1/labor-market')]);
      if (!ty.length && !inf.length && !lab.length) throw new Error('No economy data came back from Massive (check the plan).');
      return {
        items: [
          { id: 'y10',   label: '10-Year Treasury', note: 'U.S. borrowing cost for 10 years', unit: '%',  daily: true, ...lastTwo(ty, 'yield_10_year') },
          { id: 'cpi',   label: 'Inflation',        note: 'Prices vs. a year ago (CPI)',               unit: '%',  ...lastTwo(inf, 'cpi_year_over_year') },
          { id: 'unemp', label: 'Unemployment',     note: 'Workers without a job',        unit: '%',  ...lastTwo(lab, 'unemployment_rate') },
          { id: 'jobs',  label: 'Job Openings',     note: 'Jobs employers are trying to fill',         unit: 'M',  ...scale(lastTwo(lab, 'job_openings'), 1 / 1000) },
          { id: 'pay',   label: 'Avg. Hourly Pay',  note: 'Private-sector workers',                    unit: '$',  ...lastTwo(lab, 'avg_hourly_earnings') }
        ].filter(i => i.value != null)
      };
    });
    send(res, 200, out, 3600);
  } catch (e) {
    fail(res, e);
  }
}
function scale(x, k) { return x ? { ...x, value: x.value * k, prev: x.prev == null ? null : x.prev * k } : {}; }
