// Passwords, sign-in sessions, and login rate limits.
// Passwords are stored only as scrypt hashes. Sessions are signed cookies (HttpOnly, SameSite=Lax),
// so nothing about the session is readable by page scripts or other sites.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const COOKIE = 'd214s';
const DAYS = { s: 14, t: 7, a: 1 };   // student, teacher, district admin

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.LOCAL_DEV === '1') return 'local-dev-secret-local-dev-secret-0000';
  throw new HttpError(503, 'SESSION_SECRET is not set (needs 32+ characters). See SETUP.md.');
}

export function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw).normalize('NFKC'), salt, 32);
  return 's1$' + salt.toString('base64url') + '$' + h.toString('base64url');
}

export function checkPw(pw, stored) {
  if (!stored || typeof pw !== 'string' || pw.length > 200) return false;
  const [v, salt, hash] = stored.split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(pw.normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length);
  return crypto.timingSafeEqual(want, got);
}

// Easy to read aloud and type on a Chromebook: two short words and two digits, like "bluefox27".
const W1 = 'blue red gold green gray pink tan teal lime navy plum mint ruby jade sky sun moon star cool calm bold fast tall wise kind brave lucky sunny happy quick swift bright sharp proud'.split(' ');
const W2 = 'fox owl bear wolf hawk deer frog lion seal crab duck goat yak elk ant bee eel cod emu koi lynx mole newt orca puma swan toad wren otter panda tiger zebra eagle bison falcon'.split(' ');
export function newPassword() {
  const r = n => crypto.randomInt(n);
  return W1[r(W1.length)] + W2[r(W2.length)] + String(10 + r(90));
}

// A short fingerprint of the current password. Changing a password signs out old sessions.
export function pwVersion(hash) {
  return crypto.createHash('sha256').update(String(hash || '')).digest('base64url').slice(0, 10);
}

function sign(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

export function makeSession(role, id, pwHash) {
  const body = Buffer.from(JSON.stringify({ r: role, id, v: pwVersion(pwHash), e: Date.now() + DAYS[role] * 86400000 })).toString('base64url');
  return body + '.' + sign(body);
}

export function readSession(req) {
  const raw = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const tok = decodeURIComponent(raw.slice(COOKIE.length + 1));
  const [body, mac] = tok.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body)), got = Buffer.from(mac);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!s || !s.e || s.e < Date.now() || !['s', 't', 'a'].includes(s.r)) return null;
    return s;
  } catch { return null; }
}

function secureFlag(req) {
  const host = String(req.headers.host || '');
  return /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? '' : '; Secure';
}

export function setSessionCookie(req, res, token, role) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS[role] * 86400}${secureFlag(req)}`);
}

export function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`);
}

// Verify the cookie against the database so a reset password or a removed student is signed out right away.
export async function currentUser(sql, req) {
  const s = readSession(req);
  if (!s) return null;
  if (s.r === 'a') {
    const pw = process.env.ADMIN_PASSWORD || '';
    return pw && s.v === pwVersion('admin:' + pw) ? { role: 'admin', id: 0, name: 'District admin' } : null;
  }
  if (s.r === 't') {
    const [t] = await sql`select t.id, t.name, t.pw_hash, sc.name as school from teachers t join schools sc on sc.id = t.school_id where t.id = ${s.id} and t.active`;
    return t && pwVersion(t.pw_hash) === s.v ? { role: 'teacher', id: t.id, name: t.name, school: t.school } : null;
  }
  const [st] = await sql`
    select st.id, st.display, st.pw_hash, st.section_id, sec.period, t.id as teacher_id, t.name as teacher, sc.name as school
    from students st join sections sec on sec.id = st.section_id join teachers t on t.id = sec.teacher_id join schools sc on sc.id = t.school_id
    where st.id = ${s.id} and st.active`;
  return st && pwVersion(st.pw_hash) === s.v
    ? { role: 'student', id: st.id, name: st.display, sec: st.section_id, period: st.period, teacherId: st.teacher_id, teacher: st.teacher, school: st.school }
    : null;
}

export function requireRole(user, ...roles) {
  if (!user) throw new HttpError(401, 'Please sign in.');
  if (!roles.includes(user.role)) throw new HttpError(403, 'You don’t have access to that.');
}

// At most 8 wrong passwords per account every 15 minutes. A whole school shares one network
// address, so the per-network limit is much higher and only stops someone guessing across many accounts.
export async function checkRate(sql, keys) {
  const rows = await sql`select k, count(*)::int as n from login_fail where k = any(${keys}) and at > now() - interval '15 minutes' group by k`;
  if (rows.some(r => r.n >= (r.k.startsWith('ip:') ? 150 : 8))) throw new HttpError(429, 'Too many tries. Wait 15 minutes, or ask your teacher to reset your password.');
}
export async function noteFail(sql, keys) {
  for (const k of keys) await sql`insert into login_fail (k) values (${k})`;
  await sql`delete from login_fail where at < now() - interval '1 day'`;
}
export async function clearFails(sql, key) {
  await sql`delete from login_fail where k = ${key}`;
}
