// Roster import from the master spreadsheet (CSV, or rows pasted straight from Google Sheets or Excel).
// Columns: School, Teacher, Period, First Name, Last Name.
// Only the first name and enough of the last name to tell classmates apart are stored ("Jack M.").
import { bad } from './http.js';
import { hashPw, newPassword } from './auth.js';
import * as M from './market.js';
import { getSettings, setSetting } from './portfolio.js';

export const SCHOOLS = ['Hersey', 'Prospect', 'Buffalo Grove', 'Rolling Meadows', 'Elk Grove', 'Wheeling'];

export function schoolName(raw) {
  const s = String(raw || '').toLowerCase();
  if (/hersey|jhhs/.test(s)) return 'Hersey';
  if (/prospect|phs\b/.test(s)) return 'Prospect';
  if (/buffalo|bghs/.test(s)) return 'Buffalo Grove';
  if (/rolling|meadows|rmhs/.test(s)) return 'Rolling Meadows';
  if (/elk|eghs/.test(s)) return 'Elk Grove';
  if (/wheeling|whs\b/.test(s)) return 'Wheeling';
  return null;
}

export function periodName(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(?:p|per|period|hour|hr)?\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:period|hour))?$/i);
  return m ? 'P' + Number(m[1]) : s.slice(0, 20);
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const cap = s => s.replace(/(^|[\s\-'])([a-z])/g, (_, a, b) => a + b.toUpperCase());

// Parse CSV or tab-separated text, with quoted fields.
export function parseTable(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function columns(header) {
  const h = header.map(x => x.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names) => h.findIndex(x => names.some(n => x === n || x.includes(n)));
  const col = {
    school: find('school', 'building', 'campus'),
    teacher: find('teacher', 'instructor'),
    period: find('period', 'hour', 'section', 'class'),
    first: find('firstname', 'studentfirst', 'first'),
    last: find('lastname', 'studentlast', 'last', 'surname')
  };
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => ({ school: 'School', teacher: 'Teacher', period: 'Period', first: 'First Name', last: 'Last Name' })[k]);
  if (missing.length) throw bad('The first row needs these column headings: ' + missing.join(', ') + '.');
  return col;
}

// Turn the spreadsheet into schools → teachers → classes → students, with display names that are unique in each class.
export function planRoster(text) {
  const rows = parseTable(text);
  if (rows.length < 2) throw bad('Paste the spreadsheet with its heading row and at least one student.');
  const col = columns(rows[0]);
  const warnings = [], classes = new Map();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const school = schoolName(r[col.school]), teacher = clean(r[col.teacher]), period = periodName(r[col.period]);
    const first = cap(clean(r[col.first]).toLowerCase()), last = cap(clean(r[col.last]).toLowerCase());
    if (!school) return warnings.push(`Row ${line}: "${clean(r[col.school])}" isn’t one of the six schools. Skipped.`);
    if (!teacher || !period) return warnings.push(`Row ${line}: missing teacher or period. Skipped.`);
    if (!first || !last) return warnings.push(`Row ${line}: missing a student name. Skipped.`);
    if (first.length > 40 || last.length > 60 || teacher.length > 60) return warnings.push(`Row ${line}: a name is too long. Skipped.`);
    const key = school + '|' + teacher + '|' + period;
    if (!classes.has(key)) classes.set(key, { school, teacher, period, kids: [] });
    classes.get(key).kids.push({ first, last, line });
  });
  for (const c of classes.values()) {
    // Shortest last-name prefix that keeps every name in the class unique: "Jack M.", then "Jack Mi."
    for (const k of c.kids) k.n = 1;
    for (let round = 0; round < 30; round++) {
      const seen = new Map();
      for (const k of c.kids) { const d = k.first + ' ' + k.last.slice(0, k.n); (seen.get(d) || seen.set(d, []).get(d)).push(k); }
      let changed = false;
      for (const group of seen.values()) {
        if (group.length < 2 || group.every(k => k.last === group[0].last)) continue;   // same full name: numbered below
        for (const k of group) if (k.n < k.last.length) { k.n++; changed = true; }
      }
      if (!changed) break;
    }
    const used = new Map();
    for (const k of c.kids) {
      k.part = k.last.slice(0, k.n);
      let d = k.first + ' ' + k.part + '.';
      const count = (used.get(d) || 0) + 1; used.set(d, count);
      if (count > 1) { warnings.push(`Row ${k.line}: ${d} appears twice in ${c.teacher} ${c.period}. Listed as "${d} (${count})".`); d += ` (${count})`; }
      k.display = d;
    }
  }
  return { classes: [...classes.values()], warnings };
}

async function currentSpy() {
  try { const q = await M.quotes(['SPY']); return q.SPY ? q.SPY.p : null; } catch { return null; }
}

// Preview (commit = false) or import. New students and teachers get passwords, returned once for printing.
export async function importRoster(sql, text, commit) {
  const { classes, warnings } = planRoster(text);
  if (!classes.length) throw bad(warnings[0] || 'No students found.');
  const existing = await sql`
    select sc.name as school, t.name as teacher, t.id as tid, se.period, se.id as sid, st.display, st.id as stid
    from schools sc left join teachers t on t.school_id = sc.id left join sections se on se.teacher_id = t.id
    left join students st on st.section_id = se.id and st.active`;
  const has = new Set(existing.filter(r => r.display).map(r => r.school + '|' + r.teacher + '|' + r.period + '|' + r.display));
  const teacherSet = new Set(existing.filter(r => r.teacher).map(r => r.school + '|' + r.teacher));
  const summary = { classes: classes.length, students: 0, newStudents: 0, newTeachers: 0, teachers: new Set() };
  for (const c of classes) {
    summary.teachers.add(c.school + '|' + c.teacher);
    if (!teacherSet.has(c.school + '|' + c.teacher)) { teacherSet.add(c.school + '|' + c.teacher); summary.newTeachers++; }
    for (const k of c.kids) { summary.students++; if (!has.has(c.school + '|' + c.teacher + '|' + c.period + '|' + k.display)) summary.newStudents++; }
  }
  const preview = {
    warnings, classes: classes.map(c => ({ school: c.school, teacher: c.teacher, period: c.period, students: c.kids.length,
      names: c.kids.map(k => k.display), newNames: c.kids.filter(k => !has.has(c.school + '|' + c.teacher + '|' + c.period + '|' + k.display)).map(k => k.display) })),
    totals: { classes: summary.classes, teachers: summary.teachers.size, students: summary.students, newStudents: summary.newStudents, newTeachers: summary.newTeachers }
  };
  if (!commit) return preview;

  const spy = await currentSpy();
  const settings = await getSettings(sql);
  const slips = [];
  await sql.begin(async tx => {
    for (const name of SCHOOLS) await tx`insert into schools (name) values (${name}) on conflict (name) do nothing`;
    const sch = Object.fromEntries((await tx`select id, name from schools`).map(r => [r.name, r.id]));
    for (const c of classes) {
      let [t] = await tx`select id, pw_hash from teachers where school_id = ${sch[c.school]} and name = ${c.teacher}`;
      let teacherPw = null;
      if (!t) {
        teacherPw = newPassword();
        [t] = await tx`insert into teachers (school_id, name, pw_hash) values (${sch[c.school]}, ${c.teacher}, ${hashPw(teacherPw)}) returning id`;
      } else await tx`update teachers set active = true where id = ${t.id}`;
      let [se] = await tx`select id from sections where teacher_id = ${t.id} and period = ${c.period}`;
      if (se) await tx`update sections set active = true where id = ${se.id}`;
      if (!se) [se] = await tx`insert into sections (teacher_id, period) values (${t.id}, ${c.period}) returning id`;
      const made = [];
      for (const k of c.kids) {
        const [found] = await tx`select id, active from students where section_id = ${se.id} and display = ${k.display}`;
        if (found && found.active) continue;
        const pw = newPassword();
        if (found) {   // a student removed earlier and now back on the roster
          await tx`update students set active = true, pw_hash = ${hashPw(pw)} where id = ${found.id}`;
        } else {
          const [st] = await tx`insert into students (section_id, first, last_part, display, pw_hash) values (${se.id}, ${k.first}, ${k.part}, ${k.display}, ${hashPw(pw)}) returning id`;
          await tx`insert into accounts (student_id, spy_start) values (${st.id}, ${spy})`;
        }
        made.push({ name: k.display, pw });
      }
      if (made.length || teacherPw) slips.push({ school: c.school, teacher: c.teacher, teacherPw, period: c.period, students: made });
    }
  });
  if (!settings.spyStart && spy) await setSetting(sql, 'spyStart', spy);
  if (!settings.startDate) await setSetting(sql, 'startDate', M.today());
  return { ...preview, slips };
}
