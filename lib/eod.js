// End of day. Runs once each weekday evening (Vercel cron, see vercel.json) after the market closes:
//   1. money market interest   2. stock splits that start tomorrow   3. dividends and bond interest
//   4. auto-invest buys at today's close   5. each student's closing value   6. awards
// Safe to run twice: a day that's done is skipped. If a run is missed, the next one catches up (up to 10 days).
import * as M from './market.js';
import { getSettings, settleMM, dcaNext, addNote, weekStart, START_CASH } from './portfolio.js';
import { invalidateStandings } from './standings.js';

const pct = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) + '%';
const money = x => '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r4 = x => Math.round(x * 10000) / 10000;

function nyMinutes() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const h = +parts.find(p => p.type === 'hour').value, m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m;
}

export async function runEOD(sql) {
  const log = [];
  const closed = await M.holidays();
  const today = M.today();
  const [{ last }] = await sql`select max(d) as last from market_days`;
  let x = last ? M.addDays(last, 1) : today;
  if (x < M.addDays(today, -10)) x = M.addDays(today, -10);
  const days = [];
  for (; x <= today; x = M.addDays(x, 1)) if (M.isWeekday(x) && !closed.has(x)) days.push(x);
  if (days[days.length - 1] === today && nyMinutes() < 16 * 60 + 15 && process.env.EOD_IGNORE_CLOCK !== '1') { days.pop(); log.push(today + ': market day isn’t over yet'); }
  if (!days.length) log.push('Nothing to do.');
  for (const d of days) {
    let cl;
    try { cl = await M.closes(d); } catch (e) { log.push(d + ': could not get closing prices (' + e.message + ')'); break; }
    if (!cl.SPY) { log.push(d + ': closing prices aren’t published yet. Try again later.'); break; }
    log.push(await processDay(sql, d, cl, closed));
  }
  invalidateStandings();
  return log;
}

export async function processDay(sql, d, cl, closed) {
  const settings = await getSettings(sql);
  const next = M.nextTradingDay(d, closed);
  const held = new Set((await sql`select distinct sym from positions`).map(r => r.sym));
  let divs = [], splits = [];
  try { divs = (await M.dividendsOn(next)).filter(x => held.has(x.sym)); } catch (e) { console.error('[eod] dividends', e.message); }
  try { splits = (await M.splitsOn(next)).filter(x => held.has(x.sym)); } catch (e) { console.error('[eod] splits', e.message); }

  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(214214)`;
    const [done] = await tx`select 1 from market_days where d = ${d}`;
    if (done) return d + ': already done';
    const msg = [];

    // 1. Money market interest through today.
    await settleMM(tx, settings.mmRate, d);

    // 2. Splits that take effect at tomorrow's open. Share counts change now so tomorrow's prices line up.
    const splitRatio = {};
    for (const s of splits) {
      const [ins] = await tx`insert into splits (sym, exec_date, ratio) values (${s.sym}, ${next}, ${s.ratio}) on conflict do nothing returning sym`;
      if (!ins) continue;
      splitRatio[s.sym] = s.ratio;
      const holders = await tx`
        update positions set shares = round(shares * ${s.ratio}, 6), basis = basis / ${s.ratio} where sym = ${s.sym}
        returning student_id, shares, basis`;
      await tx`update trades set shares = shares * ${s.ratio}, price = price / ${s.ratio}, basis = basis / ${s.ratio} where sym = ${s.sym}`;
      const words = s.ratio >= 1 ? `${+s.ratio.toFixed(3)}-for-1` : `1-for-${+(1 / s.ratio).toFixed(3)}`;
      for (const h of holders) await addNote(tx, h.student_id, `${s.sym} is doing a ${words} stock split. You now have ${+h.shares.toFixed(4)} shares at ${money(h.basis)} average cost. Your total value didn’t change.`);
      msg.push(`split ${s.sym} ${words}`);
    }

    // 3. Dividends and bond interest: whoever holds a position tonight locks in the payment for tomorrow's ex-dividend date.
    let locked = 0;
    for (const dv of divs) {
      const pos = await tx`select student_id, side, shares from positions where sym = ${dv.sym}`;
      for (const p of pos) {
        const amount = Math.round(dv.amount * p.shares * (p.side === 'long' ? 1 : -1) * 100) / 100;
        if (!amount) continue;
        await tx`insert into income (student_id, sym, side, ex_date, pay_date, per_share, shares, amount)
                 values (${p.student_id}, ${dv.sym}, ${p.side}, ${dv.ex}, ${dv.pay}, ${dv.amount}, ${p.shares}, ${amount})
                 on conflict do nothing`;
        locked++;
      }
    }
    if (locked) msg.push(`${locked} dividend payments locked in`);

    // Payments due today arrive in cash, or buy more shares when "reinvest" is on.
    const due = await tx`select * from income where not paid and pay_date <= ${d}`;
    for (const e of due) {
      const kind = (await tx`select kind from symbols where sym = ${e.sym}`)[0]?.kind;
      const word = kind === 'bond' ? 'interest' : 'a dividend';
      if (e.side === 'short') {
        await tx`update accounts set cash = cash + ${e.amount} where student_id = ${e.student_id}`;
        await addNote(tx, e.student_id, `You were short ${e.sym} when it paid ${word}, so you paid ${money(e.amount)} to the lender.`);
        await tx`update income set paid = true where id = ${e.id}`;
        continue;
      }
      const [p] = await tx`select drip, shares, basis from positions where student_id = ${e.student_id} and sym = ${e.sym} and side = 'long'`;
      const price = cl[e.sym] / (splitRatio[e.sym] || 1);
      if (p && p.drip && price > 0) {
        const add = r4(e.amount / price);
        await tx`update positions set basis = (basis * shares + ${e.amount}) / (shares + ${add}), shares = shares + ${add}, income = income + ${e.amount}
                 where student_id = ${e.student_id} and sym = ${e.sym} and side = 'long'`;
        await tx`update income set paid = true, reinvested = ${add} where id = ${e.id}`;
        await addNote(tx, e.student_id, `${e.sym} paid you ${money(e.amount)} in ${word === 'interest' ? 'interest' : 'dividends'} and bought ${add.toFixed(3)} more shares with it.`);
      } else {
        await tx`update accounts set cash = cash + ${e.amount} where student_id = ${e.student_id}`;
        if (p) await tx`update positions set income = income + ${e.amount} where student_id = ${e.student_id} and sym = ${e.sym} and side = 'long'`;
        await tx`update income set paid = true where id = ${e.id}`;
        await addNote(tx, e.student_id, `${e.sym} paid you ${money(e.amount)} in ${word === 'interest' ? 'interest' : 'dividends'}. It went to your cash.`);
      }
    }
    if (due.length) msg.push(`${due.length} payments made`);

    // 4. Auto-invest buys due today, at today's closing price.
    const plans = await tx`select * from dca_plans where not paused and next_date <= ${d}`;
    let bought = 0;
    for (const pl of plans) {
      const price = cl[pl.sym] / (splitRatio[pl.sym] || 1);
      const nextDate = (() => { let n = dcaNext(d, pl.freq); while (closed.has(n)) n = M.addDays(n, 1); return n; })();
      if (!(price > 0)) { await tx`update dca_plans set next_date = ${nextDate} where id = ${pl.id}`; continue; }
      const [a] = await tx`select cash from accounts where student_id = ${pl.student_id} for update`;
      if (a.cash < pl.amount - 0.005) {
        await addNote(tx, pl.student_id, `Your ${pl.sym} auto-invest skipped this time. It needs ${money(pl.amount)} in cash.`);
      } else {
        const sh = r4(pl.amount / price);
        await tx`update accounts set cash = cash - ${pl.amount} where student_id = ${pl.student_id}`;
        await tx`insert into positions (student_id, sym, side, shares, basis) values (${pl.student_id}, ${pl.sym}, 'long', ${sh}, ${pl.amount / sh})
                 on conflict (student_id, sym, side) do update set
                   basis = (positions.basis * positions.shares + excluded.basis * excluded.shares) / (positions.shares + excluded.shares),
                   shares = positions.shares + excluded.shares`;
        await tx`insert into trades (student_id, sym, act, shares, price, d, auto, dca_id, at)
                 values (${pl.student_id}, ${pl.sym}, 'buy', ${sh}, ${price}, ${d}, true, ${pl.id}, ${d + 'T20:00:00Z'})`;
        bought++;
      }
      await tx`update dca_plans set next_date = ${nextDate} where id = ${pl.id}`;
    }
    if (bought) msg.push(`${bought} auto-invest buys`);

    // 5. Each student's value at today's close.
    const accts = await tx`select a.student_id, a.cash, a.mm_bal from accounts a join students st on st.id = a.student_id where st.active`;
    const pos = await tx`select student_id, sym, side, shares, basis from positions`;
    const lastPx = await M.lastPrices(tx, [...new Set(pos.map(p => p.sym))].filter(s => !(cl[s] > 0)));
    const val = new Map(accts.map(a => [a.student_id, a.cash + a.mm_bal]));
    const seen = {};
    for (const p of pos) {
      if (!val.has(p.student_id)) continue;
      const raw = cl[p.sym] > 0 ? cl[p.sym] : lastPx[p.sym];
      const price = raw > 0 ? raw / (splitRatio[p.sym] || 1) : p.basis;
      if (cl[p.sym] > 0) seen[p.sym] = cl[p.sym] / (splitRatio[p.sym] || 1);
      val.set(p.student_id, val.get(p.student_id) + (p.side === 'long' ? p.shares * price : p.shares * (2 * p.basis - price)));
    }
    const snaps = [...val].map(([sid, v]) => ({ student_id: sid, d, value: Math.round(v * 10000) / 10000 }));
    if (snaps.length) await tx`insert into snapshots ${tx(snaps, 'student_id', 'd', 'value')} on conflict (student_id, d) do update set value = excluded.value`;
    await tx`insert into market_days (d, spy) values (${d}, ${cl.SPY})`;
    if (Object.keys(seen).length) await M.rememberPrices(tx, seen);
    msg.push(`${snaps.length} portfolios valued`);

    // 6. Awards.
    await dailyAwards(tx, d);
    if (weekStart(next) !== weekStart(d)) { await weeklyAwards(tx, d); msg.push('weekly awards'); }
    return d + ': ' + msg.join(', ');
  });
}

// Every award is picked separately for the district, each school, each teacher, and each class,
// so more students get recognized. scope is 'district', 'school:<name>', 'teacher:<id>', or 'class:<section id>'.
async function saveAwards(tx, d, kinds, rows) {
  await tx`delete from awards where d = ${d} and kind = any(${kinds})`;
  if (rows.length) await tx`insert into awards ${tx(rows.map(r => ({ d, kind: r.kind, scope: r.scope, student_id: r.sid, value: r.value, detail: tx.json(r.detail) })), 'd', 'kind', 'scope', 'student_id', 'value', 'detail')}`;
}

async function groupsOf(tx) {
  const rows = await tx`
    select st.id as sid, sc.name as school, t.id as tid, t.name as teacher, se.id as sec, se.period
    from students st join sections se on se.id = st.section_id join teachers t on t.id = se.teacher_id join schools sc on sc.id = t.school_id
    where st.active and not st.practice`;
  return new Map(rows.map(r => [r.sid, [
    { scope: 'district', where: 'in the district', board: 'the district standings' },
    { scope: 'school:' + r.school, where: 'at ' + r.school, board: 'the ' + r.school + ' standings' },
    { scope: 'teacher:' + r.tid, where: 'among ' + r.teacher + '’s students', board: r.teacher + '’s standings' },
    { scope: 'class:' + r.sec, where: 'in ' + r.teacher + '’s ' + r.period + ' class', board: 'the ' + r.period + ' class standings' }
  ]]));
}

// The best item in every scope its student belongs to. better(a, b) is true when a beats b.
function bestPerScope(items, groups, better) {
  const best = new Map();
  for (const it of items) for (const g of groups.get(it.sid) || []) {
    const cur = best.get(g.scope);
    if (!cur || better(it, cur.it)) best.set(g.scope, { it, g });
  }
  return [...best.values()];
}
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');

const ACT = { sell: 'Sold', cover: 'Closed a short on' };
function tradeLesson(t, p) {
  const held = t.opened_at ? Math.max(0, Math.round((new Date(t.at) - new Date(t.opened_at)) / 86400000)) : null;
  return { stats: [['Trade', `${ACT[t.act]} ${t.sym}`], ['Held', held === null ? '—' : held === 0 ? 'Same day' : held + (held === 1 ? ' day' : ' days')], ['Profit', '+' + money(t.pnl)]],
    lesson: `${ACT[t.act]} ${t.sym} for a ${pct(p).replace('+', '')} gain${held ? ' after holding it ' + held + (held === 1 ? ' day' : ' days') : ''}.` };
}

// Small trades don't count, so nobody wins by flipping one share of a penny stock.
const MIN_TRADE = 1000;

const DAILY = ['mover_day', 'trader_day'];
const WEEKLY = ['mover_week', 'best_trade_week', 'active_week', 'climber_week', 'steady_week'];
const byTrade = (a, b) => a.p > b.p || (a.p === b.p && a.id < b.id);

async function dailyAwards(tx, d) {
  const groups = await groupsOf(tx);
  const out = [];
  const movers = await tx`
    select s.student_id, s.value,
      coalesce((select p.value from snapshots p where p.student_id = s.student_id and p.d < ${d} order by p.d desc limit 1), ${START_CASH}) as prev
    from snapshots s join students st on st.id = s.student_id where s.d = ${d} and st.active and not st.practice`;
  const up = movers.map(m => ({ sid: m.student_id, r: (m.value / m.prev - 1) * 100 })).filter(m => m.r > 0);
  for (const { it, g } of bestPerScope(up, groups, (a, b) => a.r > b.r || (a.r === b.r && a.sid < b.sid)))
    out.push({ kind: 'mover_day', scope: g.scope, sid: it.sid, value: it.r, detail: { text: pct(it.r), lesson: 'Biggest one-day gain ' + g.where + '.' } });

  const trades = (await tx`
    select t.*, t.pnl / (t.basis * t.shares) * 100 as p from trades t join students st on st.id = t.student_id
    where t.d = ${d} and t.act in ('sell','cover') and t.basis * t.shares >= ${MIN_TRADE} and t.pnl > 0 and st.active and not st.practice`).map(t => ({ ...t, sid: t.student_id }));
  for (const { it, g } of bestPerScope(trades, groups, byTrade))
    out.push({ kind: 'trader_day', scope: g.scope, sid: it.sid, value: it.p, detail: { text: pct(it.p), ...tradeLesson(it, it.p) } });
  await saveAwards(tx, d, DAILY, out);
}

async function weeklyAwards(tx, d) {
  const ws = weekStart(d);
  const groups = await groupsOf(tx);
  const out = [];
  const add = (kind, picks, detail) => { for (const { it, g } of picks) out.push({ kind, scope: g.scope, sid: it.sid, value: it.v, detail: detail(it, g) }); };
  const [prevDay] = await tx`select max(d) as d from market_days where d < ${ws}`;
  const rows = await tx`
    select s.student_id as sid, s.value,
      coalesce((select p.value from snapshots p where p.student_id = s.student_id and p.d < ${ws} order by p.d desc limit 1), ${START_CASH}) as prev,
      (select count(*)::int from trades t where t.student_id = s.student_id and not t.auto and t.d between ${ws} and ${d}) as n,
      (select count(*)::int from positions p where p.student_id = s.student_id) as holds
    from snapshots s join students st on st.id = s.student_id where s.d = ${d} and st.active and not st.practice`;
  const wk = rows.map(r => ({ ...r, r: (r.value / r.prev - 1) * 100, v: (r.value / r.prev - 1) * 100 }));
  const higherR = (a, b) => a.r > b.r || (a.r === b.r && a.sid < b.sid);

  add('mover_week', bestPerScope(wk.filter(r => r.r > 0), groups, higherR), (p, g) => ({ text: pct(p.v), lesson: 'Biggest gain ' + g.where + ' this week.' }));

  const trades = (await tx`
    select t.*, t.pnl / (t.basis * t.shares) * 100 as p from trades t join students st on st.id = t.student_id
    where t.d between ${ws} and ${d} and t.act in ('sell','cover') and t.basis * t.shares >= ${MIN_TRADE} and t.pnl > 0 and st.active and not st.practice`).map(t => ({ ...t, sid: t.student_id, v: t.p }));
  add('best_trade_week', bestPerScope(trades, groups, byTrade), p => ({ text: pct(p.v), ...tradeLesson(p, p.p) }));

  add('active_week', bestPerScope(wk.filter(r => r.n > 0).map(r => ({ ...r, v: r.n })), groups, (a, b) => a.n > b.n || (a.n === b.n && a.sid < b.sid)),
    p => ({ text: p.v + (p.v === 1 ? ' trade' : ' trades'), neutral: true }));

  if (prevDay && prevDay.d) {
    // Rank everyone within each scope before and after the week, then find each scope's biggest climber.
    const members = new Map();
    for (const r of wk) for (const g of groups.get(r.sid) || []) (members.get(g.scope) || members.set(g.scope, { g, list: [] }).get(g.scope)).list.push(r);
    for (const { g, list } of members.values()) {
      const rank = key => { const m = new Map(); list.slice().sort((a, b) => b[key] - a[key] || a.sid - b.sid).forEach((r, i) => m.set(r.sid, i + 1)); return m; };
      const before = rank('prev'), after = rank('value');
      const c = list.map(r => ({ sid: r.sid, v: before.get(r.sid) - after.get(r.sid), to: after.get(r.sid) })).sort((a, b) => b.v - a.v || a.to - b.to)[0];
      if (c && c.v > 0) out.push({ kind: 'climber_week', scope: g.scope, sid: c.sid, value: c.v,
        detail: { text: '+' + c.v, lesson: `Climbed ${c.v} ${c.v === 1 ? 'spot' : 'spots'} in ${g.board}, to ${ordinal(c.to)}.` } });
    }
  }

  add('steady_week', bestPerScope(wk.filter(r => r.n === 0 && r.holds > 0 && r.r > 0), groups, higherR),
    p => ({ text: '0 trades', stats: [['Week', pct(p.v)], ['Trades', '0']], lesson: 'Held every position all week and still finished up.' }));
  await saveAwards(tx, d, WEEKLY, out);
}
