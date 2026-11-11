// GET /api/board?school=rolling-meadows&key=TV_KEY
// Reads a school's top 10, awards, and class battle from the D214 stock sim (read only).
// The key is passed through to the sim, which checks it against its own TV_KEY. Nothing is stored here.
const SIM = (process.env.SIM_URL || 'https://d214-stock-sim.vercel.app').replace(/\/+$/, '');

export default async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const school = (u.searchParams.get('school') || '').toLowerCase();
  const key = u.searchParams.get('key') || '';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!/^[a-z0-9-]{2,40}$/.test(school) || !key || key.length > 200) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Pass a school and the TV key.' })); }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(`${SIM}/api/app?fn=tv&school=${encodeURIComponent(school)}&key=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    res.statusCode = r.status;
    res.end(JSON.stringify(r.ok ? j : { error: j.error || 'The stock sim could not send the standings.' }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'Could not reach the stock sim.' }));
  } finally { clearTimeout(timer); }
}
