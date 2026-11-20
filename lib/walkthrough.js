// Site Walkthrough: a first-day checklist for a class, shown on Checkup when the teacher turns it on.
// Steps come from trades and orders the game already keeps, plus a small "seen" record of where a
// student has been on the site (accounts.seen: { key: time first seen }).
//
//   tabs        visited all five tabs                       seen tab:portfolio, standings, checkup, charts, trade
//   stock_buy   bought a stock                              a buy of a stock (not auto-invest)
//   etf_buy     bought an ETF                               a buy of an ETF (not auto-invest)
//   three_own   owns 3 or more different investments       open positions now
//   five_trades made 5 or more trades                       trades, not counting auto-invest
//   sell        sold some shares                            a sell
//   standings   opened another player's portfolio           seen peer
//   cmp1y       compared a stock to the S&P 500 over 1Y     seen cmp1y
//   limit_buy   placed a limit buy                          an order, any status
//   stop        placed a stop loss                          a stop sell order, any status
//   trail       placed a trailing stop                      an order, any status
//   dca         set up auto-invest                          a plan or an auto-invest buy

export const WALK = ['tabs', 'stock_buy', 'etf_buy', 'three_own', 'five_trades', 'sell', 'standings', 'cmp1y', 'limit_buy', 'stop', 'trail', 'dca'];
export const TABS = ['portfolio', 'standings', 'checkup', 'charts', 'trade'];
export const SEEN_KEYS = new Set([...TABS.map(t => 'tab:' + t), 'peer', 'cmp1y', 'news']);

// seenRows: { student_id, seen, holdings, trades, last_trade }   buys: { student_id, kind, at, sym }
// sells: { student_id, at, sym }   orders: { student_id, otype, at, sym }   plans: { student_id, at, sym }
export function buildWalk(ids, seenRows, buys, sells, orders, plans) {
  const out = {};
  for (const id of ids) out[id] = Object.fromEntries(WALK.map(k => [k, { s: 'todo' }]));
  const done = (id, k, at, sym) => { const c = out[id] && out[id][k]; if (c && c.s !== 'done') Object.assign(c, { s: 'done', at, sym: sym || undefined }); };
  const part = (id, k, n, of) => { const c = out[id] && out[id][k]; if (c && c.s === 'todo' && n > 0) Object.assign(c, { s: 'wait', n, of }); };
  for (const r of seenRows) {
    const seen = r.seen || {}, id = r.student_id;
    const tabs = TABS.filter(t => seen['tab:' + t]);
    if (tabs.length === TABS.length) done(id, 'tabs', TABS.map(t => seen['tab:' + t]).sort().pop());
    else part(id, 'tabs', tabs.length, TABS.length);
    if (r.holdings >= 3) done(id, 'three_own'); else part(id, 'three_own', r.holdings, 3);
    if (r.trades >= 5) done(id, 'five_trades', r.last_trade); else part(id, 'five_trades', r.trades, 5);
    if (seen.peer) done(id, 'standings', seen.peer);
    if (seen.cmp1y) done(id, 'cmp1y', seen.cmp1y);
  }
  for (const t of buys) done(t.student_id, t.kind === 'etf' ? 'etf_buy' : 'stock_buy', t.at, t.sym);
  for (const t of sells) done(t.student_id, 'sell', t.at, t.sym);
  for (const o of orders) done(o.student_id, o.otype === 'limit' ? 'limit_buy' : o.otype === 'stop' ? 'stop' : 'trail', o.at, o.sym);
  for (const p of plans) done(p.student_id, 'dca', p.at, p.sym);
  return out;
}

export async function walkthrough(sql, ids) {
  if (!ids.length) return {};
  const [seenRows, buys, sells, orders, plans] = await Promise.all([
    sql`select a.student_id, a.seen,
          (select count(*)::int from positions p where p.student_id = a.student_id) as holdings,
          (select count(*)::int from trades t where t.student_id = a.student_id and not t.auto) as trades,
          (select max(at) from trades t where t.student_id = a.student_id and not t.auto) as last_trade
        from accounts a where a.student_id = any(${ids})`,
    sql`select t.student_id, y.kind, min(t.at) as at, (array_agg(t.sym order by t.at))[1] as sym
        from trades t join symbols y on y.sym = t.sym
        where t.student_id = any(${ids}) and t.act = 'buy' and not t.auto and y.kind in ('stock', 'etf')
        group by t.student_id, y.kind`,
    sql`select student_id, min(at) as at, (array_agg(sym order by at))[1] as sym
        from trades where student_id = any(${ids}) and act = 'sell' group by student_id`,
    sql`select student_id, otype, min(placed_at) as at, (array_agg(sym order by placed_at))[1] as sym
        from orders where student_id = any(${ids})
          and ((otype = 'limit' and side = 'buy') or (otype = 'stop' and side = 'sell') or otype = 'trail')
        group by student_id, otype`,
    sql`select student_id, min(at) as at, (array_agg(sym order by at))[1] as sym from (
          select student_id, created_at as at, sym from dca_plans where student_id = any(${ids})
          union all select student_id, at, sym from trades where student_id = any(${ids}) and auto) x
        group by student_id`
  ]);
  return buildWalk(ids, seenRows, buys, sells, orders, plans);
}

// Students whose class has the walkthrough on (a teacher's practice portfolio: any of their classes).
export async function walkOn(sql, ids) {
  if (!ids.length) return new Set();
  const rows = await sql`
    select st.id from students st join sections se on se.id = st.section_id
    where st.id = any(${ids}) and (se.walkthrough
      or (st.practice and exists (select 1 from sections o where o.teacher_id = se.teacher_id and o.walkthrough and o.active)))`;
  return new Set(rows.map(r => r.id));
}

// Remember the first time a student reaches a place on the site.
export async function markSeen(sql, sid, key) {
  if (!SEEN_KEYS.has(key)) return false;
  await sql`update accounts set seen = coalesce(seen, '{}'::jsonb) || jsonb_build_object(${key}::text, now())
            where student_id = ${sid} and not (coalesce(seen, '{}'::jsonb) ? ${key}::text)`;
  return true;
}

export const walkDone = c => c ? WALK.filter(k => c[k] && c[k].s === 'done').length : 0;
