// Live standings: every student's portfolio valued at current prices, plus the awards
// from the last end-of-day run. Computed once and shared for 30 seconds per server instance.
import * as M from './market.js';
import { getSettings, mmValueOn, pendingSplits, START_CASH, weekStart } from './portfolio.js';

let cache = { t: 0, p: null };
let remembered = 0;

export function standings(sql, fresh = false) {
  if (!fresh && cache.p && Date.now() - cache.t < 30000) return cache.p;
  const p = compute(sql);
  cache = { t: Date.now(), p };
  p.catch(() => { if (cache.p === p) cache = { t: 0, p: null }; });
  return p;
}
export function invalidateStandings() { cache = { t: 0, p: null }; }

async function compute(sql) {
  const d = M.today();
  const [settings, studs, pos, secs, adj] = await Promise.all([
    getSettings(sql),
    sql`select st.id, st.display as name, st.section_id as sec, sc.name as school, a.cash, a.mm_bal, a.mm_last
        from students st join sections se on se.id = st.section_id join teachers t on t.id = se.teacher_id
        join schools sc on sc.id = t.school_id join accounts a on a.student_id = st.id
        where st.active and t.active order by st.id`,
    sql`select p.student_id as sid, p.sym, p.side, p.shares, p.basis from positions p join students st on st.id = p.student_id where st.active`,
    sql`select se.id, se.period, t.id as tid, t.name as teacher, sc.name as school,
          (select count(*)::int from students st where st.section_id = se.id and st.active) as size
        from sections se join teachers t on t.id = se.teacher_id join schools sc on sc.id = t.school_id
        where t.active and se.active order by sc.name, t.name, se.period`,
    pendingSplits(sql)
  ]);
  const syms = [...new Set(pos.map(p => p.sym).concat('SPY'))];
  let qs = {};
  try { qs = await M.quotes(syms); } catch (e) { console.error('[standings] quotes', e.message); }
  const lastKnown = await M.lastPrices(sql, syms.filter(s => !qs[s]));
  if (Object.keys(qs).length && Date.now() - remembered > 300000) { remembered = Date.now(); M.rememberPrices(sql, qs).catch(() => {}); }
  const px = (sym, fallback) => {
    const p = qs[sym] ? qs[sym].p / (adj[sym] || 1) : lastKnown[sym];
    return p > 0 ? p : fallback;
  };

  const values = new Map(studs.map(s => [s.id, s.cash + mmValueOn(s.mm_bal, s.mm_last, settings.mmRate, d)]));
  const owners = {};
  for (const p of pos) {
    const price = px(p.sym, p.basis);
    const v = p.side === 'long' ? p.shares * price : p.shares * (2 * p.basis - price);
    values.set(p.sid, (values.get(p.sid) || 0) + v);
    if (p.side === 'long') (owners[p.sym] = owners[p.sym] || new Set()).add(p.sid);
  }
  const students = studs.map(s => {
    const value = values.get(s.id);
    return { id: s.id, name: s.name, sec: s.sec, school: s.school, value: Math.round(value * 100) / 100, ret: Math.round((value / START_CASH - 1) * 1e6) / 1e4 };
  });

  const sections = secs.filter(s => s.size > 0).map(s => ({ id: s.id, teacher: s.teacher, tid: s.tid, school: s.school, period: s.period, size: s.size }));
  const teachers = [...new Map(sections.map(s => [s.tid, { id: s.tid, name: s.teacher, school: s.school }])).values()];
  const spyNow = qs.SPY ? qs.SPY.p : null;
  const spyRet = spyNow && settings.spyStart ? (spyNow / settings.spyStart - 1) * 100 : 0;

  // District-wide only, never about one student: the stock the most students own that is down today.
  let popular = null;
  const ownedSyms = Object.keys(owners);
  if (ownedSyms.length) {
    const kinds = Object.fromEntries((await sql`select sym, name, kind from symbols where sym = any(${ownedSyms})`).map(r => [r.sym, r]));
    const list = ownedSyms.filter(s => kinds[s] && kinds[s].kind === 'stock' && qs[s] && qs[s].pc)
      .map(s => ({ sym: s, name: kinds[s].name, owners: owners[s].size, chg: (qs[s].p / qs[s].pc - 1) * 100 }))
      .sort((a, b) => b.owners - a.owners);
    const pick = list.find(x => x.chg < 0) || list[0];
    if (pick) popular = pick;
  }

  const awards = await latestAwards(sql);
  return { at: Date.now(), d, students, sections, teachers, spyRet, spyStart: settings.spyStart, awards, popular,
    quotes: Object.fromEntries(Object.entries(qs).map(([s, q]) => [s, { p: q.p, pc: q.pc }])) };
}

const LABEL = {
  trader_day: 'Trader of the Day', mover_day: 'Mover of the Day', mover_week: 'Mover of the Week',
  best_trade_week: 'Best Trade of the Week', active_week: 'Most Active of the Week',
  climber_week: 'Biggest Climber · Week', steady_week: 'Steady Hands · Week'
};
const DAILY = ['trader_day', 'mover_day'];
const WEEKLY = ['mover_week', 'best_trade_week', 'active_week', 'climber_week', 'steady_week'];

async function latestAwards(sql) {
  const rows = await sql`
    select a.d, a.kind, a.student_id, a.value, a.detail from awards a
    where (a.kind = any(${DAILY}) and a.d = (select max(d) from awards where kind = any(${DAILY})))
       or (a.kind = any(${WEEKLY}) and a.d = (select max(d) from awards where kind = any(${WEEKLY})))`;
  const order = DAILY.concat(WEEKLY);
  return rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .map(r => ({ kind: r.kind, label: LABEL[r.kind], d: r.d, student: r.student_id, value: r.value, ...r.detail }));
}

// Teachers see a bit more about their own students: trades this week and when they last traded.
export async function activity(sql, studentIds) {
  if (!studentIds.length) return {};
  const wk = weekStart(M.today());
  const rows = await sql`
    select st.id,
      (select count(*)::int from trades t where t.student_id = st.id and not t.auto and t.d >= ${wk}) as week,
      (select count(*)::int from trades t where t.student_id = st.id and not t.auto) as total,
      (select max(at) from trades t where t.student_id = st.id) as last_trade,
      (select count(*)::int from positions p where p.student_id = st.id) as holdings,
      st.last_login
    from students st where st.id = any(${studentIds})`;
  return Object.fromEntries(rows.map(r => [r.id, { week: r.week, total: r.total, lastTrade: r.last_trade, holdings: r.holdings, lastLogin: r.last_login }]));
}
