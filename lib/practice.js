// A teacher's practice portfolio: a regular account (same trades, dividends, auto-invest, and
// end-of-day history as students) that never appears in any standings, rosters, or awards.
// It lives in a hidden "Practice" class that belongs to the teacher.
import * as M from './market.js';

export async function practiceId(sql, teacherId, create = true) {
  const [found] = await sql`select st.id from students st join sections se on se.id = st.section_id
    where st.practice and se.teacher_id = ${teacherId} limit 1`;
  if (found || !create) return found ? found.id : null;
  let spy = null;
  try { spy = (await M.quotes(['SPY'])).SPY?.p || null; } catch { /* filled in later */ }
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(214000 + ${teacherId})`;
    const [again] = await tx`select st.id from students st join sections se on se.id = st.section_id where st.practice and se.teacher_id = ${teacherId} limit 1`;
    if (again) return again.id;
    const [t] = await tx`select name from teachers where id = ${teacherId}`;
    let [se] = await tx`select id from sections where teacher_id = ${teacherId} and period = 'Practice'`;
    if (!se) [se] = await tx`insert into sections (teacher_id, period, active) values (${teacherId}, 'Practice', false) returning id`;
    const [st] = await tx`insert into students (section_id, first, last_part, display, practice) values (${se.id}, ${t.name}, '', ${t.name}, true) returning id`;
    await tx`insert into accounts (student_id, spy_start) values (${st.id}, ${spy})`;
    return st.id;
  });
}
