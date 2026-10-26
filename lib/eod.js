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

async function award(tx, d, kind, sid, value, detail) {
  await tx`insert into awards (d, kind, student_id, value, detail) values (${d}, ${kind}, ${sid}, ${value}, ${tx.json(detail)})
           on conflict (d, kind) do update set student_id = excluded.student_id, value = excluded.value, detail = excluded.detail`;
}

const ACT = { sell: 'Sold', cover: 'Closed a short on' };
function tradeLesson(t, p) {
  const held = t.opened_at ? Math.max(0, Math.round((new Date(t.at) - new Date(t.opened_at)) / 86400000)) : null;
  return { stats: [['Trade', `${ACT[t.act]} ${t.sym}`], ['Held', held === null ? '—' : held === 0 ? 'Same day' : held + (held === 1 ? ' day' : ' days')], ['Profit', '+' + money(t.pnl)]],
    lesson: `${ACT[t.act]} ${t.sym} for a ${pct(p).replace('+', '')} gain${held ? ' after holding it ' + held + (held === 1 ? ' day' : ' days') : ''}.` };
}

// Small trades don't count, so nobody wins by flipping one share of a penny stock.
const MIN_TRADE = 1000;

async function dailyAwards(tx, d) {
  const movers = await tx`
    select s.student_id, s.value,
      coalesce((select p.value from snapshots p where p.student_id = s.student_id and p.d < ${d} order by p.d desc limit 1), ${START_CASH}) as prev
    from snapshots s join students st on st.id = s.student_id where s.d = ${d} and st.active`;
  const best = movers.map(m => ({ sid: m.student_id, r: (m.value / m.prev - 1) * 100 })).sort((a, b) => b.r - a.r || a.sid - b.sid)[0];
  if (best && best.r > 0) await award(tx, d, 'mover_day', best.sid, best.r, { text: pct(best.r), lesson: 'Biggest one-day gain in the district.' });
  else await tx`delete from awards where d = ${d} and kind = 'mover_day'`;

  const [t] = await tx`
    select t.* , t.pnl / (t.basis * t.shares) * 100 as p from trades t join students st on st.id = t.student_id
    where t.d = ${d} and t.act in ('sell','cover') and t.basis * t.shares >= ${MIN_TRADE} and t.pnl > 0 and st.active
    order by p desc, t.id limit 1`;
  if (t) await award(tx, d, 'trader_day', t.student_id, t.p, { text: pct(t.p), ...tradeLesson(t, t.p) });
  else await tx`delete from awards where d = ${d} and kind = 'trader_day'`;
}

async function weeklyAwards(tx, d) {
  const ws = weekStart(d);
  const [prevDay] = await tx`select max(d) as d from market_days where d < ${ws}`;
  const rows = await tx`
    select s.student_id as sid, s.value,
      coalesce((select p.value from snapshots p where p.student_id = s.student_id and p.d < ${ws} order by p.d desc limit 1), ${START_CASH}) as prev,
      (select count(*)::int from trades t where t.student_id = s.student_id and not t.auto and t.d between ${ws} and ${d}) as n,
      (select count(*)::int from positions p where p.student_id = s.student_id) as holds
    from snapshots s join students st on st.id = s.student_id where s.d = ${d} and st.active`;
  const wk = rows.map(r => ({ ...r, r: (r.value / r.prev - 1) * 100 }));
  const set = async (kind, pick, detail) => pick ? award(tx, d, kind, pick.sid, pick.v, detail(pick)) : tx`delete from awards where d = ${d} and kind = ${kind}`;

  const mover = wk.slice().sort((a, b) => b.r - a.r || a.sid - b.sid)[0];
  await set('mover_week', mover && mover.r > 0 ? { sid: mover.sid, v: mover.r } : null, p => ({ text: pct(p.v), lesson: 'Biggest gain in the district this week.' }));

  const [bt] = await tx`
    select t.*, t.pnl / (t.basis * t.shares) * 100 as p from trades t join students st on st.id = t.student_id
    where t.d between ${ws} and ${d} and t.act in ('sell','cover') and t.basis * t.shares >= ${MIN_TRADE} and t.pnl > 0 and st.active
    order by p desc, t.id limit 1`;
  await set('best_trade_week', bt ? { sid: bt.student_id, v: bt.p } : null, p => ({ text: pct(p.v), ...tradeLesson(bt, bt.p) }));

  const act = wk.filter(r => r.n > 0).sort((a, b) => b.n - a.n || a.sid - b.sid)[0];
  await set('active_week', act ? { sid: act.sid, v: act.n } : null, p => ({ text: p.v + (p.v === 1 ? ' trade' : ' trades'), neutral: true }));

  if (prevDay && prevDay.d) {
    const rank = key => { const m = new Map(); wk.slice().sort((a, b) => b[key] - a[key] || a.sid - b.sid).forEach((r, i) => m.set(r.sid, i + 1)); return m; };
    const before = rank('prev'), after = rank('value');
    const climb = wk.map(r => ({ sid: r.sid, v: before.get(r.sid) - after.get(r.sid), to: after.get(r.sid) })).sort((a, b) => b.v - a.v || a.to - b.to)[0];
    await set('climber_week', climb && climb.v > 0 ? climb : null, p => ({ text: '+' + p.v, lesson: `Climbed ${p.v} spots in the district standings, to ${p.to}${['th', 'st', 'nd', 'rd'][(p.to % 100 > 10 && p.to % 100 < 14) ? 0 : p.to % 10] || 'th'}.` }));
  }

  const steady = wk.filter(r => r.n === 0 && r.holds > 0 && r.r > 0).sort((a, b) => b.r - a.r || a.sid - b.sid)[0];
  await set('steady_week', steady ? { sid: steady.sid, v: steady.r } : null, p => ({ text: '0 trades', stats: [['Week', pct(p.v)], ['Trades', '0']], lesson: 'Held every position all week and still finished up.' }));
}
