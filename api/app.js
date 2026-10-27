// /api/app?fn=...  Every signed-in part of the game: sign-in, portfolio, trades, standings, teacher and admin tools.
// One function file keeps the project well under Vercel's limit on the number of functions.
import { sqlReady } from '../lib/db.js';
import { HttpError, bad, query, readJson, sendJson, sendError, requireSameSite } from '../lib/http.js';
import { checkPw, hashPw, encPw, decPw, newPassword, makeSession, setSessionCookie, clearSessionCookie, currentUser, requireRole, checkRate, noteFail, clearFails } from '../lib/auth.js';
import * as P from '../lib/portfolio.js';
import * as M from '../lib/market.js';
import { standings, invalidateStandings, activity } from '../lib/standings.js';
import { importRoster, SCHOOLS, periodName } from '../lib/roster.js';
import { runEOD } from '../lib/eod.js';
import { practiceId } from '../lib/practice.js';

const ip = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
const int = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad('Bad request.'); return n; };

export default async function handler(req, res) {
  try {
    const fn = query(req).get('fn') || '';
    const route = ROUTES[fn];
    if (!route) throw new HttpError(404, 'Not found.');
    if (route.post) requireSameSite(req); else if (req.method !== 'GET') throw new HttpError(405, 'Use GET.');
    const sql = await sqlReady();
    const user = route.public ? null : await currentUser(sql, req);
    const body = route.post ? await readJson(req) : null;
    const out = await route.run({ req, res, sql, user, body, q: query(req) });
    if (!res.writableEnded) sendJson(res, 200, out);
  } catch (e) {
    sendError(res, e);
  }
}

const ROUTES = {
  /* ---------- signing in ---------- */
  // Who can sign in: schools and their teachers. Student names only appear after a teacher is picked.
  dir: { public: true, run: async ({ sql, q }) => {
    const tid = q.get('teacher');
    if (tid) {
      const rows = await sql`
        select se.id as sec, se.period, st.id, st.display as name from sections se
        join teachers t on t.id = se.teacher_id
        left join students st on st.section_id = se.id and st.active
        where t.id = ${int(tid)} and t.active and se.active order by se.period, st.display`;
      const secs = new Map();
      for (const r of rows) { if (!secs.has(r.sec)) secs.set(r.sec, { id: r.sec, period: r.period, students: [] }); if (r.id) secs.get(r.sec).students.push({ id: r.id, name: r.name }); }
      return { sections: [...secs.values()].filter(s => s.students.length) };
    }
    const rows = await sql`select sc.name as school, t.id, t.name from teachers t join schools sc on sc.id = t.school_id where t.active order by t.name`;
    return { schools: SCHOOLS.map(name => ({ name, teachers: rows.filter(r => r.school === name).map(r => ({ id: r.id, name: r.name })) })) };
  } },

  login: { public: true, post: true, run: async ({ req, res, sql, body }) => {
    const kind = body.kind, pw = String(body.password || '').trim().toLowerCase();
    const net = 'ip:' + ip(req);
    if (kind === 'admin') {
      const real = process.env.ADMIN_PASSWORD || '';
      if (!real) throw new HttpError(503, 'ADMIN_PASSWORD is not set. See SETUP.md.');
      await checkRate(sql, ['adm', net]);
      if (String(body.password || '') !== real) { await noteFail(sql, ['adm', net]); throw new HttpError(401, 'That password isn’t right.'); }
      await clearFails(sql, 'adm');
      setSessionCookie(req, res, makeSession('a', 0, 'admin:' + real), 'a');
      return { ok: true, role: 'admin' };
    }
    const id = int(body.id);
    const key = (kind === 'teacher' ? 'tch:' : 'stu:') + id;
    await checkRate(sql, [key, net]);
    const [row] = kind === 'teacher'
      ? await sql`select id, pw_hash from teachers where id = ${id} and active`
      : await sql`select id, pw_hash from students where id = ${id} and active`;
    // Teachers' passwords are case-sensitive only if they set one with capitals; generated ones are lowercase.
    const ok = row && (checkPw(pw, row.pw_hash) || checkPw(String(body.password || '').trim(), row.pw_hash));
    if (!ok) { await noteFail(sql, [key, net]); throw new HttpError(401, 'That password isn’t right. Check with your teacher if you forgot it.'); }
    await clearFails(sql, key);
    if (kind !== 'teacher') await sql`update students set last_login = now() where id = ${id}`;
    const role = kind === 'teacher' ? 't' : 's';
    setSessionCookie(req, res, makeSession(role, id, row.pw_hash), role);
    return { ok: true, role: kind === 'teacher' ? 'teacher' : 'student' };
  } },

  logout: { public: true, post: true, run: async ({ req, res }) => { clearSessionCookie(req, res); return { ok: true }; } },

  /* ---------- the signed-in person ---------- */
  me: { run: async ({ sql, user }) => {
    if (!user) throw new HttpError(401, 'Please sign in.');
    if (user.role === 'teacher') {
      // Teachers get a practice portfolio that never counts in the standings.
      const pid = await practiceId(sql, user.id);
      const state = await P.portfolioState(sql, pid);
      return { role: 'teacher', me: { ...user, practiceId: pid }, ...state };
    }
    if (user.role !== 'student') return { role: user.role, me: user };
    const state = await P.portfolioState(sql, user.id);
    return { role: 'student', me: { id: user.id, name: user.name, sec: user.sec, period: user.period, teacher: user.teacher, school: user.school }, ...state };
  } },

  // Every change a student makes goes through here and returns their updated portfolio.
  act: { post: true, run: async ({ sql, user, body }) => {
    requireRole(user, 'student', 'teacher');
    const sid = user.role === 'teacher' ? await practiceId(sql, user.id) : user.id;
    let result = null;
    switch (body.a) {
      case 'trade': result = await P.trade(sql, sid, body); break;
      case 'mm': result = await P.moveMM(sql, sid, body); break;
      case 'dca_start': result = await P.dcaStart(sql, sid, body); break;
      case 'dca_toggle': await P.dcaToggle(sql, sid, int(body.id)); break;
      case 'dca_stop': await P.dcaStop(sql, sid, int(body.id)); break;
      case 'drip': await P.toggleDrip(sql, sid, body.sym); break;
      case 'watch': await P.setWatch(sql, sid, body.sym, !!body.on); break;
      case 'dismiss': await P.dismissNotes(sql, sid); break;
      default: throw bad('Unknown action.');
    }
    if (['trade', 'mm', 'dca_start'].includes(body.a)) invalidateStandings();
    const state = await P.portfolioState(sql, sid);
    return { result, ...state };
  } },

  /* ---------- standings (everyone signed in) ---------- */
  standings: { run: async ({ sql, user }) => {
    requireRole(user, 'student', 'teacher', 'admin');
    return standings(sql);
  } },

  // One student's portfolio as a snapshot: what they hold and how it's doing, not share counts or trades.
  // Their teacher and the admin also get the full detail.
  student: { run: async ({ sql, user, q }) => {
    requireRole(user, 'student', 'teacher', 'admin');
    const id = int(q.get('id'));
    const full = user.role === 'admin' || (user.role === 'teacher' && await teachesStudent(sql, user.id, id));
    const st = await standings(sql);
    let s = st.students.find(x => x.id === id);
    const [acct] = await sql`select a.cash, a.mm_bal, a.mm_last, st.display, st.practice from accounts a join students st on st.id = a.student_id where a.student_id = ${id} and st.active`;
    if (!acct || (!s && !acct.practice)) throw new HttpError(404, 'Student not found.');
    const pos = await sql`select p.sym, p.side, p.shares, p.basis, y.kind from positions p left join symbols y on y.sym = p.sym where p.student_id = ${id}`;
    let extra = {};
    try { extra = await M.quotes(pos.map(p => p.sym).filter(sym => !st.quotes[sym])); } catch { /* fall back below */ }
    const qp = sym => (st.quotes[sym] || extra[sym] || {}).p;
    const last = await M.lastPrices(sql, pos.map(p => p.sym).filter(sym => !qp(sym)));
    if (!s) {   // a teacher's practice portfolio: valued here because it isn't in the standings
      const settings = await P.getSettings(sql);
      const mm = P.mmValueOn(acct.mm_bal, acct.mm_last, settings.mmRate, M.today());
      const value = acct.cash + mm + pos.reduce((a, p) => { const px = qp(p.sym) || last[p.sym] || p.basis; return a + (p.side === 'long' ? p.shares * px : p.shares * (2 * p.basis - px)); }, 0);
      s = { name: acct.display, value: Math.round(value * 100) / 100, ret: Math.round((value / P.START_CASH - 1) * 1e6) / 1e4, practice: true };
      acct.mm_bal = mm;
    }
    const TY = { stock: 'Stock', etf: 'ETF', bond: 'Bond', crypto: 'Crypto' };
    const holds = pos.map(p => {
      const px = qp(p.sym) || last[p.sym] || p.basis;
      const v = p.side === 'long' ? p.shares * px : p.shares * (2 * p.basis - px);
      const g = (p.side === 'long' ? px / p.basis - 1 : 1 - px / p.basis) * 100;
      return { s: p.sym, ty: p.side === 'short' ? 'Short' : TY[p.kind] || 'Stock', v, g, ...(full ? { n: p.shares, b: p.basis, px } : {}) };
    }).sort((a, b) => b.v - a.v);
    if (acct.mm_bal > 0.005) holds.push({ s: 'Money mkt', ty: 'MM', v: acct.mm_bal, g: null });
    holds.push({ s: 'Cash', ty: 'Cash', v: acct.cash, g: null });
    holds.forEach(h => { h.w = h.v / s.value * 100; });
    const out = { id, name: s.name, value: s.value, ret: s.ret, holds, practice: !!s.practice };
    if (full) {
      out.trades = (await sql`select sym, act, shares, price, at, auto, pnl from trades where student_id = ${id} order by at desc limit 100`)
        .map(t => ({ sym: t.sym, act: t.act, n: t.shares, price: t.price, at: t.at, auto: t.auto, pnl: t.pnl }));
      out.activity = (await activity(sql, [id]))[id];
    }
    return out;
  } },

  // Recent payments for a fund or stock, for the yield and "next payment" figures.
  yield: { run: async ({ user, q }) => {
    requireRole(user, 'student', 'teacher', 'admin');
    const sym = String(q.get('sym') || '').toUpperCase();
    if (!M.TICKER.test(sym)) throw bad('Bad ticker.');
    try { return await M.dividendInfo(sym); } catch { return { last: 0, lastEx: null, freq: 0, ttm: 0 }; }
  } },

  /* ---------- teachers ---------- */
  teacher: { run: async ({ sql, user, q }) => {
    requireRole(user, 'teacher', 'admin');
    const tid = user.role === 'teacher' ? user.id : (q.get('teacher') ? int(q.get('teacher')) : null);
    const secs = await sql`
      select se.id, se.period, t.id as tid, t.name as teacher, sc.name as school from sections se
      join teachers t on t.id = se.teacher_id join schools sc on sc.id = t.school_id
      where t.active and se.active ${tid ? sql`and t.id = ${tid}` : sql``} order by sc.name, t.name, se.period`;
    const st = await standings(sql);
    const roster = await sql`select id, display, section_id, last_login from students where active and section_id = any(${secs.map(s => s.id)}) order by display`;
    const act = await activity(sql, roster.map(r => r.id));
    const byId = new Map(st.students.map(s => [s.id, s]));
    const rankIn = list => { const m = new Map(); list.slice().sort((a, b) => b.ret - a.ret).forEach((s, i) => m.set(s.id, i + 1)); return m; };
    const district = rankIn(st.students);
    return {
      spyRet: st.spyRet,
      sections: secs.map(se => {
        const kids = roster.filter(r => r.section_id === se.id).map(r => ({ id: r.id, name: r.display, ...(byId.get(r.id) || { value: 100000, ret: 0 }), ...act[r.id], lastLogin: r.last_login }));
        const cr = rankIn(kids);
        kids.forEach(k => { k.classRank = cr.get(k.id); k.districtRank = district.get(k.id); });
        kids.sort((a, b) => a.classRank - b.classRank);
        const avg = kids.length ? kids.reduce((a, k) => a + k.ret, 0) / kids.length : 0;
        return { id: se.id, period: se.period, teacher: se.teacher, tid: se.tid, school: se.school, avg, students: kids };
      }),
      districtSize: st.students.length
    };
  } },

  teacher_act: { post: true, run: async ({ sql, user, body }) => {
    requireRole(user, 'teacher', 'admin');
    const mine = async sid => { if (user.role === 'admin') return; if (!(await teachesStudent(sql, user.id, sid))) throw new HttpError(403, 'That student isn’t in your classes.'); };
    const mySection = async secId => { if (user.role === 'admin') return; const [r] = await sql`select 1 from sections where id = ${secId} and teacher_id = ${user.id}`; if (!r) throw new HttpError(403, 'That isn’t your class.'); };
    switch (body.a) {
      case 'reset_pw': {
        const id = int(body.studentId); await mine(id);
        const pw = newPassword();
        const [s] = await sql`update students set pw_hash = ${hashPw(pw)}, pw_enc = ${encPw(pw)} where id = ${id} returning display`;
        await clearFails(sql, 'stu:' + id);
        const [info] = await sql`select se.id as "sectionId", se.period, t.id as "teacherId", t.name as teacher, sc.name as school from students st join sections se on se.id = st.section_id join teachers t on t.id = se.teacher_id join schools sc on sc.id = t.school_id where st.id = ${id}`;
        return { name: s.display, pw, slip: { ...info, students: [{ id, name: s.display, pw }] } };
      }
      // Rename a class (its period label). Students, passwords, and portfolios stay the same.
      case 'rename_class': {
        const secId = int(body.sectionId); await mySection(secId);
        const period = periodName(body.period);
        if (!period || period.length > 20) throw bad('Enter a class name of 20 characters or fewer, like P7.');
        const [taken] = await sql`select 1 from sections where period = ${period} and id <> ${secId}
          and teacher_id = (select teacher_id from sections where id = ${secId})`;
        if (taken) throw bad('This teacher already has a class called ' + period + '.');
        await sql`update sections set period = ${period} where id = ${secId}`;
        invalidateStandings();
        return { period };
      }
      // Sign-in slips for a class, any time. Students whose passwords were made before slips could be
      // reprinted have none on file; with fillMissing they get new passwords first.
      case 'slips': {
        const secId = int(body.sectionId); await mySection(secId);
        const [info] = await sql`select se.id as "sectionId", se.period, t.id as "teacherId", t.name as teacher, t.pw_enc, sc.name as school
          from sections se join teachers t on t.id = se.teacher_id join schools sc on sc.id = t.school_id where se.id = ${secId}`;
        const kids = await sql`select id, display, pw_enc from students where section_id = ${secId} and active order by display`;
        const students = [];
        let renewed = 0;
        for (const k of kids) {
          let pw = decPw(k.pw_enc);
          if (!pw && body.fillMissing) {
            pw = newPassword(); renewed++;
            await sql`update students set pw_hash = ${hashPw(pw)}, pw_enc = ${encPw(pw)} where id = ${k.id}`;
            await clearFails(sql, 'stu:' + k.id);
          }
          students.push({ id: k.id, name: k.display, pw });
        }
        const { pw_enc, ...slip } = info;
        return { slips: [{ ...slip, teacherPw: decPw(pw_enc), students }], missing: students.filter(s => !s.pw).length, renewed };
      }
      case 'reset_class': {
        const secId = int(body.sectionId); await mySection(secId);
        const kids = await sql`select id, display from students where section_id = ${secId} and active order by display`;
        const out = [];
        for (const k of kids) { const pw = newPassword(); await sql`update students set pw_hash = ${hashPw(pw)}, pw_enc = ${encPw(pw)} where id = ${k.id}`; await clearFails(sql, 'stu:' + k.id); out.push({ id: k.id, name: k.display, pw }); }
        const [info] = await sql`select se.id as "sectionId", se.period, t.id as "teacherId", t.name as teacher, sc.name as school from sections se join teachers t on t.id = se.teacher_id join schools sc on sc.id = t.school_id where se.id = ${secId}`;
        return { slips: [{ ...info, students: out }] };
      }
      case 'remove': {
        const id = int(body.studentId); await mine(id);
        await sql`update students set active = false where id = ${id}`;
        invalidateStandings();
        return { ok: true };
      }
      case 'add': {
        const secId = int(body.sectionId); await mySection(secId);
        const [info] = await sql`select se.period, t.name as teacher, sc.name as school from sections se join teachers t on t.id = se.teacher_id join schools sc on sc.id = t.school_id where se.id = ${secId}`;
        const first = String(body.first || '').trim(), last = String(body.last || '').trim();
        if (!first || !last) throw bad('Enter a first and last name.');
        const csv = `School,Teacher,Period,First Name,Last Name\n"${info.school}","${info.teacher.replace(/"/g, '""')}","${info.period}","${first.replace(/"/g, '""')}","${last.replace(/"/g, '""')}"`;
        const r = await importRoster(sql, csv, true);
        invalidateStandings();
        if (!r.slips.length || !r.slips[0].students.length) throw bad('That student is already in this class.');
        return { slips: r.slips.map(s => ({ ...s, teacherPw: null })) };
      }
      default: throw bad('Unknown action.');
    }
  } },

  /* ---------- district admin ---------- */
  admin: { run: async ({ sql, user }) => {
    requireRole(user, 'admin');
    const settings = await P.getSettings(sql);
    const teachers = await sql`
      select t.id, t.name, sc.name as school,
        (select count(*)::int from sections se where se.teacher_id = t.id and se.active) as classes,
        (select count(*)::int from students st join sections se on se.id = st.section_id where se.teacher_id = t.id and st.active and not st.practice) as students
      from teachers t join schools sc on sc.id = t.school_id where t.active order by sc.name, t.name`;
    const [days] = await sql`select max(d) as last, count(*)::int as n from market_days`;
    const [counts] = await sql`select (select count(*)::int from students where active and not practice) as students, (select count(*)::int from trades) as trades`;
    let market = 'unknown'; try { market = await M.status(); } catch { /* shown as unknown */ }
    return { settings, teachers, lastEod: days.last, eodDays: days.n, counts, market, today: M.today(),
      env: { cron: !!process.env.CRON_SECRET, massive: !!process.env.MASSIVE_API_KEY || process.env.MARKET_MOCK === '1' } };
  } },

  admin_act: { post: true, run: async ({ sql, user, body }) => {
    requireRole(user, 'admin');
    switch (body.a) {
      case 'import': {
        const r = await importRoster(sql, String(body.csv || ''), !!body.commit);
        if (body.commit) invalidateStandings();
        return r;
      }
      case 'settings': {
        const s = await P.getSettings(sql);
        if (body.mmRate !== undefined) {
          const rate = Number(body.mmRate);
          if (!isFinite(rate) || rate < 0 || rate > 15) throw bad('Pick a rate from 0% to 15%.');
          await P.settleMM(sql, s.mmRate, M.today());   // interest so far is earned at the old rate
          await P.setSetting(sql, 'mmRate', Math.round(rate * 100) / 100);
        }
        if (body.trading !== undefined) await P.setSetting(sql, 'trading', !!body.trading);
        for (const k of ['minPrice', 'minShortPrice']) if (body[k] !== undefined) {
          const v = Number(body[k]); if (!isFinite(v) || v < 0 || v > 100) throw bad('Pick a price from $0 to $100.');
          await P.setSetting(sql, k, v);
        }
        invalidateStandings();
        return P.getSettings(sql);
      }
      case 'eod': return { log: await runEOD(sql) };
      case 'teacher_pw': {
        const id = int(body.teacherId), pw = newPassword();
        const [t] = await sql`update teachers set pw_hash = ${hashPw(pw)}, pw_enc = ${encPw(pw)} where id = ${id} returning name`;
        if (!t) throw bad('Teacher not found.');
        await clearFails(sql, 'tch:' + id);
        const [ti] = await sql`select sc.name as school from teachers t join schools sc on sc.id = t.school_id where t.id = ${id}`;
        return { name: t.name, pw, slip: { school: ti.school, teacher: t.name, teacherId: id, teacherPw: pw, period: '', students: [] } };
      }
      // Remove a whole class (for a wrong or duplicate roster). Its students can no longer sign in
      // and drop out of the standings. Importing a class with the same name later brings it back.
      case 'class_remove': {
        const secId = int(body.sectionId);
        const [se] = await sql`update sections set active = false where id = ${secId} returning period`;
        if (!se) throw bad('Class not found.');
        const gone = await sql`update students set active = false where section_id = ${secId} and active returning id`;
        invalidateStandings();
        return { ok: true, removed: gone.length };
      }
      case 'teacher_remove': {
        await sql`update teachers set active = false where id = ${int(body.teacherId)}`;
        invalidateStandings();
        return { ok: true };
      }
      // Start the competition over: every student back to $100,000 cash. Rosters and passwords stay.
      case 'reset_all': {
        if (body.confirm !== 'RESET') throw bad('Type RESET to confirm.');
        let spy = null; try { spy = (await M.quotes(['SPY']))?.SPY?.p || null; } catch { /* keep null */ }
        await sql.begin(async tx => {
          await tx`delete from trades`; await tx`delete from positions`; await tx`delete from dca_plans`; await tx`delete from income`;
          await tx`delete from snapshots`; await tx`delete from awards`; await tx`delete from market_days`;
          await tx`update accounts set cash = 100000, mm_bal = 0, mm_earned = 0, mm_last = null, notes = '[]'::jsonb, spy_start = ${spy}`;
        });
        await P.setSetting(sql, 'spyStart', spy);
        await P.setSetting(sql, 'startDate', M.today());
        invalidateStandings();
        return { ok: true, spyStart: spy };
      }
      default: throw bad('Unknown action.');
    }
  } }
};

async function teachesStudent(sql, teacherId, studentId) {
  const [r] = await sql`select 1 from students st join sections se on se.id = st.section_id where st.id = ${studentId} and se.teacher_id = ${teacherId}`;
  return !!r;
}
