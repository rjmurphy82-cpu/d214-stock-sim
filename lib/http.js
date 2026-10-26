// Small request and response helpers shared by the app's server functions.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function bad(message) { return new HttpError(400, message); }

export function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { throw bad('Bad request.'); } }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 2_000_000) throw new HttpError(413, 'That upload is too big.'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { throw bad('Bad request.'); }
}

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function sendError(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500 && status !== 503) console.error('[app]', e && (e.stack || e.message));
  const message = status >= 500 && status !== 503 ? 'Something went wrong on our end. Try again in a minute.' : (e && e.message) || 'Error';
  sendJson(res, status, { error: message });
}

// Writes must come from this site's own page: JSON body plus a custom header that
// other sites cannot send without a CORS preflight (which this app never allows).
export function requireSameSite(req) {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/json') || req.headers['x-d214'] !== '1') throw new HttpError(403, 'Forbidden.');
}
