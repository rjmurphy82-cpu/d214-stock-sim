// Today's Research (Nov 2026): a checklist on Checkup for classes where the teacher turns it on.
// Each step is a fund that sums up one part of the market. It checks the first time the student opens
// that fund on Charts + News (accounts.seen 'res:SYM'), and the worksheet asks them to pull its numbers.
// Funds stand in for the market pieces: KBWB for the KBW Bank Index (BKX), VOO for VFINX,
// BND for PTTAX (mutual funds don't trade here), and USO for WTI crude (OIL no longer trades).

export const RESEARCH = ['KBWB', 'XLB', 'XLI', 'XLU', 'XLE', 'XLP', 'XLY', 'XLK', 'VOO', 'DIA', 'BND', 'USO', 'GLD'];
export const RES_KEYS = RESEARCH.map(s => 'res:' + s);

export function buildResearch(ids, seenRows) {
  const out = {};
  for (const id of ids) out[id] = Object.fromEntries(RESEARCH.map(s => [s, { s: 'todo' }]));
  for (const r of seenRows) {
    const seen = r.seen || {}, c = out[r.student_id];
    if (!c) continue;
    for (const s of RESEARCH) if (seen['res:' + s]) c[s] = { s: 'done', at: seen['res:' + s] };
  }
  return out;
}

export async function research(sql, ids) {
  if (!ids.length) return {};
  const rows = await sql`select student_id, seen from accounts where student_id = any(${ids})`;
  return buildResearch(ids, rows);
}

// Students whose class has it on (a teacher's practice portfolio: any of their classes).
export async function researchOn(sql, ids) {
  if (!ids.length) return new Set();
  const rows = await sql`
    select st.id from students st join sections se on se.id = st.section_id
    where st.id = any(${ids}) and (se.research
      or (st.practice and exists (select 1 from sections o where o.teacher_id = se.teacher_id and o.research and o.active)))`;
  return new Set(rows.map(r => r.id));
}

export const researchDone = c => c ? RESEARCH.filter(s => c[s] && c[s].s === 'done').length : 0;
