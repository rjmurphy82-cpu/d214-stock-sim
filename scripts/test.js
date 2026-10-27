// End-to-end test against a running dev server with MARKET_MOCK=1 and an empty test database.
// It signs in as the admin, imports a made-up roster, trades as students, runs end of day, and checks the results.
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3214';
const ADMIN = process.env.ADMIN_PASSWORD;

function client() {
  let cookie = '';
  const call = async (fn, body, qs = '') => {
    const r = await fetch(`${BASE}/api/app?fn=${fn}${qs}`, body === undefined ? { headers: { cookie } } : {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-d214': '1' }, body: JSON.stringify(body)
    });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  };
  return call;
}

const TEACHERS = [['Mr. Callahan', 'Hersey', ['P2', 'P6']], ['Ms. Novak', 'Prospect', ['P3']], ['Ms. Brooks', 'Hersey', ['P1']], ['Mr. Delgado', 'Buffalo Grove', ['P4', 'P7']],
  ['Ms. Tran', 'Rolling Meadows', ['P5']], ['Mr. Kowalczyk', 'Elk Grove', ['P2']], ['Ms. Sandoval', 'Wheeling', ['P3', 'P8']], ['Mr. Fitzgerald', 'Buffalo Grove', ['P6']],
  ['Ms. Adeyemi', 'Elk Grove', ['P1']], ['Mr. Lindgren', 'Rolling Meadows', ['P4', 'P5']], ['Mr. Hollis', 'Wheeling', ['P7']], ['Ms. Pryor', 'Prospect', ['P3']]];
const FIRST = 'Aiden Bella Caleb Dani Eli Fiona Gabe Hana Ian Jade Kai Lena Mateo Nora Omar Piper Quinn Rosa Sam Tess Uma Vince Wren Xavier Yara Zoe Adam Brooke Carlos Dylan'.split(' ');
const LAST = 'Martin Miller Moore Nguyen Olsen Patel Quinn Reyes Smith Torres Underwood Vance Walsh Young Zhang Adams Baker Clark Diaz Evans'.split(' ');

function roster() {
  const lines = ['School,Teacher,Period,First Name,Last Name'];
  let k = 0;
  for (const [t, s, periods] of TEACHERS) for (const p of periods) {
    const size = periods.length > 1 ? 13 : 25;
    for (let i = 0; i < size; i++, k++) lines.push(`${s === 'Hersey' ? 'John Hersey High School' : s},${t},${p.replace('P', 'Period ')},${FIRST[k % FIRST.length]},${LAST[(k * 7) % LAST.length]}`);
  }
  // Two students in one class who would both be "Jack M." and one exact duplicate.
  lines.push('Hersey,Mr. Callahan,P2,Jack,Martin', 'Hersey,Mr. Callahan,P2,Jack,Miller', 'Hersey,Mr. Callahan,P2,Jack,Miller', 'Nowhere High,Mr. X,P1,Bad,Row');
  return lines.join('\n');
}

const ok = (label, cond, extra) => { assert.ok(cond, label + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); console.log('  ✓ ' + label); };

(async () => {
  const admin = client();
  ok('signed out by default', (await admin('me')).status === 401);
  ok('wrong admin password rejected', (await admin('login', { kind: 'admin', password: 'nope' })).status === 401);
  ok('admin signs in', (await admin('login', { kind: 'admin', password: ADMIN })).ok);
  ok('POST without the site header is refused', (await fetch(`${BASE}/api/app?fn=act`, { method: 'POST', body: '{}' })).status === 403);

  const preview = await admin('admin_act', { a: 'import', csv: roster(), commit: false });
  ok('roster preview', preview.totals && preview.totals.students >= 300, preview);
  ok('preview warns about the unknown school and duplicate', preview.warnings.length === 2, preview.warnings);
  const imp = await admin('admin_act', { a: 'import', csv: roster(), commit: true });
  ok('roster imported with slips', imp.slips && imp.slips.length === 16, { n: imp.slips && imp.slips.length });
  const cal = imp.slips.find(s => s.teacher === 'Mr. Callahan' && s.period === 'P2');
  ok('similar names get longer last-name parts', ['Jack Ma.', 'Jack Mi.', 'Jack Mi. (2)'].every(n => cal.students.some(s => s.name === n)), cal.students.map(s => s.name));
  ok('teachers get passwords', cal.teacherPw && /^[a-z]+\d\d$/.test(cal.teacherPw));
  const again = await admin('admin_act', { a: 'import', csv: roster(), commit: true });
  ok('importing the same roster twice adds nobody', again.totals.newStudents === 0 && again.slips.length === 0, again.totals);

  const dir = await admin('dir');
  const callahan = dir.schools.find(s => s.name === 'Hersey').teachers.find(t => t.name === 'Mr. Callahan');
  const dirT = await admin('dir', undefined, '&teacher=' + callahan.id);
  ok('directory lists classes and names', dirT.sections.length === 2 && dirT.sections[0].students.length > 10);
  const jack = dirT.sections.flatMap(s => s.students).find(s => s.name === 'Jack Mi.');
  const jackPw = cal.students.find(s => s.name === 'Jack Mi.').pw;

  const stu = client();
  ok('wrong student password rejected', (await stu('login', { kind: 'student', id: jack.id, password: 'wrong' })).status === 401);
  ok('student signs in (password not case sensitive)', (await stu('login', { kind: 'student', id: jack.id, password: jackPw.toUpperCase() })).ok);
  let me = await stu('me');
  ok('student starts with $100,000', me.role === 'student' && me.P.cash === 100000 && me.me.name === 'Jack Mi.', me);
  ok('student cannot reach admin tools', (await stu('admin')).status === 403);

  let r = await stu('act', { a: 'trade', sym: 'NVDA', side: 'buy', n: 10 });
  ok('buy 10 NVDA', r.result && r.P.pos.some(p => p.sym === 'NVDA' && p.n === 10), r);
  const nvdaPx = r.result.price;
  ok('cash went down by the cost', Math.abs(r.P.cash - (100000 - Math.round(nvdaPx * 10 * 100) / 100)) < 0.01, { cash: r.P.cash });
  r = await stu('act', { a: 'trade', sym: 'BND', side: 'buy', n: 100 });
  ok('buy a bond fund', r.P.pos.some(p => p.sym === 'BND'));
  r = await stu('act', { a: 'trade', sym: 'BND', side: 'short', n: 5 });
  ok('bond funds cannot be shorted', r.status === 400, r);
  r = await stu('act', { a: 'trade', sym: 'TSLA', side: 'short', n: 20 });
  ok('short TSLA', r.P.pos.some(p => p.sym === 'TSLA' && p.side === 'short'), r);
  r = await stu('act', { a: 'trade', sym: 'NVDA', side: 'sell', n: 4 });
  ok('sell part of NVDA', r.P.pos.find(p => p.sym === 'NVDA').n === 6 && r.P.closed.length === 1, r.P.closed);
  r = await stu('act', { a: 'trade', sym: 'NVDA', side: 'sell', n: 50 });
  ok('cannot sell more than owned', r.status === 400);
  r = await stu('act', { a: 'trade', sym: 'AAPL', side: 'buy', n: 1e6 });
  ok('cannot spend more than cash', r.status === 400 && /cash/i.test(r.error));
  r = await stu('act', { a: 'trade', sym: 'TSLA', side: 'cover', n: 20 });
  ok('close the short', !r.P.pos.some(p => p.sym === 'TSLA') && r.P.closed.some(c => c.sym === 'TSLA (short)'));
  r = await stu('act', { a: 'mm', dir: 'in', amt: 5000 });
  ok('move $5,000 to money market', r.P.mm.bal === 5000, r.P.mm);
  r = await stu('act', { a: 'mm', dir: 'out', amt: 9000 });
  ok('cannot move out more than the balance', r.status === 400);
  r = await stu('act', { a: 'dca_start', sym: 'VOO', amt: 500, freq: 'week' });
  ok('start auto-invest with a first buy', r.P.dca.length === 1 && r.P.dca[0].buys.length === 1 && r.P.pos.some(p => p.sym === 'VOO'), r);
  r = await stu('act', { a: 'dca_start', sym: 'VOO', amt: 500, freq: 'week' });
  ok('only one plan per stock', r.status === 400);
  r = await stu('act', { a: 'drip', sym: 'BND' });
  ok('reinvest toggles on', r.P.pos.find(p => p.sym === 'BND').drip === true);
  r = await stu('act', { a: 'watch', sym: 'NFLX', on: true });
  ok('add to watchlist', r.P.watch.includes('NFLX'));
  ok('trades this week counted (auto-invest not counted)', r.P.tradesWeek === 5, { tw: r.P.tradesWeek });

  // A few other students trade so the standings and awards have something to rank.
  const others = cal.students.filter(s => s.name !== 'Jack Mi.').slice(0, 6);
  const syms = ['AAPL', 'MSFT', 'GBTC', 'XOM', 'COST', 'JPM'];
  for (const [i, o] of others.entries()) {
    const c = client(); const id = dirT.sections.flatMap(s => s.students).find(s => s.name === o.name).id;
    await c('login', { kind: 'student', id, password: o.pw });
    const t = await c('act', { a: 'trade', sym: syms[i], side: 'buy', n: 40 + i * 10 });
    assert.ok(t.result, JSON.stringify(t));
  }
  const st = await stu('standings');
  ok('standings include everyone', st.students.length >= 300 && st.sections.length === 16 && st.teachers.length === 12, { n: st.students.length });
  const meRow = st.students.find(s => s.id === jack.id);
  ok('my standing is live-valued', meRow && Math.abs(meRow.value - 100000) < 5000, meRow);
  const snap = await stu('student', undefined, '&id=' + dirT.sections.flatMap(s => s.students).find(s => s.name === others[0].name).id);
  ok('students see another portfolio as a snapshot only', snap.holds && !snap.trades && snap.holds.every(h => h.n === undefined), snap);

  // Teacher view.
  const tch = client();
  ok('teacher signs in', (await tch('login', { kind: 'teacher', id: callahan.id, password: cal.teacherPw })).ok);
  const tv = await tch('teacher');
  ok('teacher sees only their classes', tv.sections.length === 2 && tv.sections.every(s => s.teacher === 'Mr. Callahan'), tv.sections.map(s => s.teacher));
  const full = await tch('student', undefined, '&id=' + jack.id);
  ok('teacher sees full detail for their student', full.trades && full.trades.length >= 5 && full.holds[0].n !== undefined);
  const novak = dir.schools.find(s => s.name === 'Prospect').teachers.find(t => t.name === 'Ms. Novak');
  const novakKid = (await admin('dir', undefined, '&teacher=' + novak.id)).sections[0].students[0];
  ok('teacher cannot reset another teacher’s student', (await tch('teacher_act', { a: 'reset_pw', studentId: novakKid.id })).status === 403);
  const reset = await tch('teacher_act', { a: 'reset_pw', studentId: jack.id });
  ok('teacher resets a password', reset.pw && reset.name === 'Jack Mi.');
  ok('old session is signed out after reset', (await stu('me')).status === 401);
  ok('new password works', (await stu('login', { kind: 'student', id: jack.id, password: reset.pw })).ok);
  const added = await tch('teacher_act', { a: 'add', sectionId: dirT.sections[0].id, first: 'New', last: 'Kid' });
  const rn = await tch('teacher_act', { a: 'rename_class', sectionId: dirT.sections[1].id, period: 'Period 9' });
  ok('teacher renames a class (Period 9 becomes P9)', rn.period === 'P9', rn);
  ok('cannot rename to a name the teacher already uses', (await tch('teacher_act', { a: 'rename_class', sectionId: dirT.sections[0].id, period: 'P9' })).status === 400);
  ok('cannot rename another teacher’s class', (await tch('teacher_act', { a: 'rename_class', sectionId: (await admin('dir', undefined, '&teacher=' + novak.id)).sections[0].id, period: 'P1' })).status === 403);
  ok('teacher adds a student', added.slips && added.slips[0].students[0].name === 'New K.', added);

  // Settings and end of day.
  const set = await admin('admin_act', { a: 'settings', mmRate: 4.25, trading: false });
  ok('admin changes rate and pauses trading', set.mmRate === 4.25 && set.trading === false);
  r = await stu('act', { a: 'trade', sym: 'AAPL', side: 'buy', n: 1 });
  ok('trades blocked while paused', r.status === 409);
  await admin('admin_act', { a: 'settings', trading: true });
  const eod = await admin('admin_act', { a: 'eod' });
  ok('end of day runs', Array.isArray(eod.log), eod);
  console.log('    ' + eod.log.join('\n    '));
  const eod2 = await admin('admin_act', { a: 'eod' });
  ok('end of day is safe to run twice', eod2.log.every(l => /already done|Nothing|isn’t over/.test(l)), eod2.log);

  // Admin reset before launch.
  ok('reset needs confirmation', (await admin('admin_act', { a: 'reset_all', confirm: 'nope' })).status === 400);
  ok('reset everything', (await admin('admin_act', { a: 'reset_all', confirm: 'RESET' })).ok);
  me = await stu('me');
  ok('student is back to $100,000 with no history', me.P.cash === 100000 && me.P.pos.length === 0 && me.P.log.length === 0);
  ok('sign out', (await stu('logout', {})).ok && (await stu('me')).status === 401);
  console.log('\nAll tests passed.');
})().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
