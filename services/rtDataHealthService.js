// RT data health (28 Oct): RT's new API key returns slimmed candidate and
// booking records. Screens read check() to show an honest banner. When a
// missing field comes BACK, or a sensitive one appears, HeartBeat creates one
// high-priority task for Joy (once per field, never repeated) so the re-test
// list can run. Never reads or stores the sensitive values themselves.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const RESTORE_FIELDS = { obStatus: 'Onboarding status (obStatus)', visaDetails: 'Visa details', references: 'References' };
const SENSITIVE_FIELDS = { bankDetails: 'Bank details', taxDeclarations: 'Tax declarations', dateOfBirth: 'Date of birth' };
const HEARTBEAT_CLASSIFICATION = '16ab121d-9c7f-414b-9bec-5c6dcf4c9ff2';
let cache = { at: 0, value: null };

async function check({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 15 * 60 * 1000) return cache.value;
  const db = getDb();
  const fields = [...Object.keys(RESTORE_FIELDS), ...Object.keys(SENSITIVE_FIELDS)];
  const r = (await db.execute({
    sql: `SELECT count(*) n, ${fields.map(f => `count(*) FILTER (WHERE jsonb_exists(raw, '${f}')) "${f}"`).join(', ')}
          FROM rt_candidates_cache WHERE status = 1 AND is_deleted IS NOT TRUE`, args: []
  })).rows[0];
  const n = Number(r.n);
  const present = Object.fromEntries(fields.map(f => [f, Number(r[f]) > 0]));
  let historyPresent = null;
  try { const { bookings } = await require('../routes/centres').getCentresAndBookings(); historyPresent = bookings.some(b => Array.isArray(b.history)); } catch {}
  const value = {
    onboardingMissing: n > 0 && !present.obStatus, visaMissing: n > 0 && !present.visaDetails, visaStopgap: (() => { const t = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }); const v = require('./educatorComplianceService'); const to = Object.keys(require('../data/visa-audit-stopgap.json')).map(v.visaAuditValidTo).filter(d => d >= t).sort().pop(); return to ? v.visaAuditLabel(to) : null; })(), referencesMissing: n > 0 && !present.references,
    bookingHistoryMissing: historyPresent === null ? null : !historyPresent,
    sensitivePresent: Object.keys(SENSITIVE_FIELDS).filter(f => present[f]), since: '27 Oct',
    onboardingFromCio: n > 0 && !present.obStatus && await require('./cioOnboardingBridgeService').bridgeActive().catch(() => false)
  };
  cache = { at: Date.now(), value };
  await alertChanges(present, historyPresent).catch(err => console.error('RT data health alert failed:', err.message));
  return value;
}

async function alertOnce(key, title, body) {
  const db = getDb();
  const ins = (await db.execute({ sql: 'INSERT INTO rt_field_alerts (field_key) VALUES (?) ON CONFLICT (field_key) DO NOTHING RETURNING field_key', args: [key] })).rows;
  if (!ins.length) return false; // already alerted once
  const taskId = uuidv4();
  await db.execute({
    sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
          VALUES (?, 'management', ?, ?, ?, 'to_do', 'high', ?, NULL, 'system@rawtalent.internal', 'Auto — RT data health', '[]', '[]', '[]')`,
    args: [taskId, HEARTBEAT_CLASSIFICATION, title, body, JSON.stringify(['joy@rawtalent.com.au'])]
  });
  await db.execute({ sql: 'UPDATE rt_field_alerts SET task_id = ? WHERE field_key = ?', args: [taskId, key] });
  return true;
}

async function alertChanges(present, historyPresent) {
  for (const [f, label] of Object.entries(RESTORE_FIELDS)) {
    if (present[f]) await alertOnce(`restored:${f}`, `✅ RT is sending ${label} again`,
      `HeartBeat's nightly RT sync now includes ${label} (missing since 27 Oct). The "RT data incomplete" banners for it switch off by themselves.\n\nNext: run the re-test list (RawTalent/Reports/HeartBeat-Retest-When-Keys-Return.md), and check Micropods ready-to-roster, OSHC Ready and the compliance counts look right again.`);
  }
  if (historyPresent) await alertOnce('restored:booking_history', '✅ RT is sending booking history again',
    'RT bookings include their status history again (cancel reasons). The fill rate and cancellation splits are accurate again. Re-run the cancellation report if you need one.');
  for (const [f, label] of Object.entries(SENSITIVE_FIELDS)) {
    if (present[f]) await alertOnce(`sensitive:${f}`, `⚠️ RT is now sending ${label} to HeartBeat`,
      `HeartBeat's RT sync now receives ${label}. That's sensitive data you asked Yuvraj to keep excluded. HeartBeat doesn't show it anywhere, but it is now stored in HeartBeat's copy of RT (rt_candidates_cache.raw). Please ask Yuvraj to remove it from the API scope, or tell me to strip it before it's stored.`);
  }
}

module.exports = { check };
