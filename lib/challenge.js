// Advanced Trades Challenge: a class assignment of seven trades a student can complete in one day.
// Checked from the orders and trades the game already keeps, so nothing new is stored.
//
//   limit_buy   a limit order in the buy direction (buy, or close a short) placed
//   limit_sell  a limit order in the sell direction (sell, or short) placed
//   stop        a stop order (stop loss) placed
//   stop_limit  a stop limit order placed
//   trail       a trailing stop placed
//   dca         an auto-invest buy
//   short       a short sale (any order type)
//
// Limit and stop-type orders count once they're placed: they wait for a price and may not fill for days.
// Auto-invest and shorts count once they fill (a waiting one shows as "waiting").

export const STEPS = ['limit_buy', 'limit_sell', 'stop', 'stop_limit', 'trail', 'dca', 'short'];
export const PLACED_COUNTS = new Set(['limit_buy', 'limit_sell', 'stop', 'stop_limit', 'trail']);

// Which step an advanced order counts toward.
export function orderStep(otype, side) {
  if (otype === 'limit') return side === 'buy' || side === 'cover' ? 'limit_buy' : 'limit_sell';
  if (otype === 'stop' || otype === 'stop_limit' || otype === 'trail') return otype;
  return null;
}

// Turn order and trade summary rows into each student's checklist.
// orders: { student_id, otype, side, status, at, sym }   trades: { student_id, act, auto, at, sym }   plans: { student_id, sym }
// Each step is { s: 'done'|'wait'|'todo', at, sym }.
export function buildChecks(ids, orders, trades, plans) {
  const out = {};
  for (const id of ids) out[id] = Object.fromEntries(STEPS.map(k => [k, { s: 'todo' }]));
  const mark = (id, k, s, at, sym) => {
    const c = out[id] && out[id][k];
    if (!c) return;
    if (s === 'done') { if (c.s !== 'done' || new Date(at) < new Date(c.at)) Object.assign(c, { s, at, sym }); }
    else if (c.s === 'todo') Object.assign(c, { s, at, sym });
  };
  for (const t of trades) {
    if (t.act === 'short') mark(t.student_id, 'short', 'done', t.at, t.sym);
    if (t.auto) mark(t.student_id, 'dca', 'done', t.at, t.sym);
  }
  for (const o of orders) {
    const k = orderStep(o.otype, o.side);
    if (k && PLACED_COUNTS.has(k)) mark(o.student_id, k, 'done', o.at, o.sym);
    else if (k && o.status !== 'canceled') mark(o.student_id, k, o.status === 'filled' ? 'done' : 'wait', o.at, o.sym);
    // A short order that's still waiting.
    if (o.status === 'pending' && o.side === 'short') mark(o.student_id, 'short', 'wait', o.at, o.sym);
  }
  for (const p of plans) mark(p.student_id, 'dca', 'wait', null, p.sym);
  return out;
}

export async function challenge(sql, ids) {
  if (!ids.length) return {};
  const [orders, trades, plans] = await Promise.all([
    sql`select student_id, otype, side, status,
               min(case when otype <> 'market' then placed_at else coalesce(done_at, placed_at) end) as at,
               (array_agg(sym order by placed_at))[1] as sym
        from orders where student_id = any(${ids})
          and (otype <> 'market' or (status = 'pending' and side = 'short'))
        group by student_id, otype, side, status`,
    sql`select student_id, act, auto, min(at) as at, (array_agg(sym order by at))[1] as sym
        from trades where student_id = any(${ids}) and (act = 'short' or auto)
        group by student_id, act, auto`,
    sql`select student_id, sym from dca_plans where student_id = any(${ids})`
  ]);
  return buildChecks(ids, orders, trades, plans);
}

// Students whose class has the challenge turned on. A teacher's practice portfolio counts as on when any
// of that teacher's classes has it on, so the teacher can try it out.
export async function challengeOn(sql, ids) {
  if (!ids.length) return new Set();
  const rows = await sql`
    select st.id from students st join sections se on se.id = st.section_id
    where st.id = any(${ids}) and (se.challenge
      or (st.practice and exists (select 1 from sections o where o.teacher_id = se.teacher_id and o.challenge and o.active)))`;
  return new Set(rows.map(r => r.id));
}

export const doneCount = c => c ? STEPS.filter(k => c[k] && c[k].s === 'done').length : 0;
