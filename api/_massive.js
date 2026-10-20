// Shared helpers for the Massive market data functions.
// Files whose names start with an underscore are not exposed as endpoints by Vercel.
//
// The API key lives only on the server, in the MASSIVE_API_KEY environment variable.
// The browser never sees it, and these functions return only the numbers the page displays.

const BASE = 'https://api.massive.com';

export const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export function apiKey() {
  return process.env.MASSIVE_API_KEY || '';
}

export function param(req, name) {
  const u = new URL(req.url, 'http://localhost');
  return (u.searchParams.get(name) || '').trim();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Call a Massive REST endpoint and return its JSON.
export async function massive(path, params = {}) {
  const key = apiKey();
  if (!key) throw new HttpError(503, 'MASSIVE_API_KEY is not set');
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: ctl.signal });
    if (r.status === 404) throw new HttpError(404, 'Not found');
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'Massive rejected the API key or plan (' + r.status + ')');
    if (!r.ok) throw new HttpError(502, 'Massive returned ' + r.status);
    return await r.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, e.name === 'AbortError' ? 'Massive timed out' : 'Could not reach Massive');
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a binary file (company logos) from Massive with the key attached server side.
export async function massiveFile(fileUrl) {
  const key = apiKey();
  if (!key) throw new HttpError(503, 'MASSIVE_API_KEY is not set');
  const url = new URL(fileUrl);
  if (url.hostname !== 'api.massive.com') throw new HttpError(404, 'Unexpected logo host');
  url.searchParams.set('apiKey', key);
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, 'Logo unavailable');
  return { type: r.headers.get('content-type') || 'image/png', body: Buffer.from(await r.arrayBuffer()) };
}

// Small in-memory cache, per warm server instance. Concurrent callers share one request.
const memo = new Map();
export function cached(id, ttlMs, fn) {
  const hit = memo.get(id);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = fn();
  memo.set(id, { t: Date.now(), p });
  p.catch(() => { if (memo.get(id) && memo.get(id).p === p) memo.delete(id); });
  if (memo.size > 800) memo.delete(memo.keys().next().value);
  return p;
}

// JSON response. sMaxAge lets Vercel's CDN share one answer across every student.
export function send(res, status, body, sMaxAge) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', status === 200 && sMaxAge
    ? `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 2}`
    : 'no-store');
  res.end(JSON.stringify(body));
}

export function fail(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) console.error('[massive]', e && e.message);
  const error = status === 503 ? 'Live market data is not set up yet.'
    : status === 404 ? 'Not found.'
    : 'Market data is unavailable right now.';
  send(res, status, { error });
}

// Massive timestamps can be nanoseconds or milliseconds. Normalize to milliseconds.
export function toMs(t) {
  if (!t) return 0;
  return t > 1e14 ? Math.floor(t / 1e6) : t;
}

// Calendar date in New York, where U.S. markets trade.
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function nyDate(ms) {
  return NY.format(new Date(ms));
}

export const round = (x, d = 4) => (typeof x === 'number' && isFinite(x)) ? Math.round(x * 10 ** d) / 10 ** d : null;
