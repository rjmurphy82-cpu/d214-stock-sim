// /api/cron: the end-of-day job (see lib/eod.js). Vercel calls it on the schedule in vercel.json
// and sends "Authorization: Bearer <CRON_SECRET>". Nobody else can run it.
import { sqlReady } from '../lib/db.js';
import { sendJson, sendError, HttpError } from '../lib/http.js';
import { runEOD } from '../lib/eod.js';

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, 'CRON_SECRET is not set. See SETUP.md.');
    if (req.headers.authorization !== 'Bearer ' + secret) throw new HttpError(401, 'Unauthorized.');
    const sql = await sqlReady();
    const log = await runEOD(sql);
    console.log('[eod]', log.join(' | '));
    sendJson(res, 200, { log });
  } catch (e) {
    sendError(res, e);
  }
}
