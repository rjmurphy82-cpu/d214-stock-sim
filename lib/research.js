import { today } from './market.js';

// Today's Research (Nov 2026): a checklist on Checkup for classes where the teacher turns it on, for that
// day only (sections.research_day). Students open all 13 funds. Each step is a fund that sums up one part of the market. It checks the first time the student opens
// that fund on Charts + News (accounts.seen 'res:SYM'), and the worksheet asks them to pull its numbers.
// Funds stand in for the market pieces: KBWB for the KBW Bank Index (BKX), VOO for VFINX,
// BND for PTTAX (mutual funds don't trade here), and USO for WTI crude (OIL no longer trades).

export const RESEARCH = ['KBWB', 'XLB', 'XLI', 'XLU', 'XLE', 'XLP', 'XLY', 'XLK', 'VOO', 'DIA', 'BND', 'USO', 'GLD'];
export const QUIZ_N = 9;   // Research questions on Checkup; the answer is kept as 'rq:<n>:y' (right) or 'rq:<n>:n' (wrong)
export const RES_KEYS = [...RESEARCH.map(s => 'res:' + s), ...Array.from({ length: QUIZ_N }, (_, i) => ['rq:' + (i + 1) + ':y', 'rq:' + (i + 1) + ':n']).flat()];

export function buildResearch(ids, seenRows) {
  const out = {};
  for (const id of ids) out[id] = Object.fromEntries(RESEARCH.map(s => [s, { s: 'todo' }]));
  for (const r of seenRows) {
    const seen = r.seen || {}, c = out[r.student_id];
    if (!c) continue;
    for (const s of RESEARCH) if (seen['res:' + s]) c[s] = { s: 'done', at: seen['res:' + s] };
    // A question counts as right only if its first answer was right (no wrong answer on file).
    c.quiz = {};
    for (let n = 1; n <= QUIZ_N; n++) if (seen['rq:' + n + ':n']) c.quiz[n] = 'n'; else if (seen['rq:' + n + ':y']) c.quiz[n] = 'y';
  }
  return out;
}

export async function research(sql, ids) {
  if (!ids.length) return {};
  const rows = await sql`select student_id, seen from accounts where student_id = any(${ids})`;
  return buildResearch(ids, rows);
}

// Students whose class has it on today (a teacher's practice portfolio: any of their classes).
export async function researchOn(sql, ids) {
  if (!ids.length) return new Set();
  const d = today();
  const rows = await sql`
    select st.id from students st join sections se on se.id = st.section_id
    where st.id = any(${ids}) and ((se.research and se.research_day = ${d})
      or (st.practice and exists (select 1 from sections o where o.teacher_id = se.teacher_id and o.research and o.research_day = ${d} and o.active)))`;
  return new Set(rows.map(r => r.id));
}

export const quizRight = c => c && c.quiz ? Object.values(c.quiz).filter(v => v === 'y').length : 0;
export const researchDone = c => c ? RESEARCH.filter(s => c[s] && c[s].s === 'done').length : 0;
