const { getDb, transaction } = require('../db/database');
const rtApi = require('./rtApiReportService');

// A sync "stuck" in 'running' for longer than this is treated as dead (a
// crashed/redeployed process, not an actual slow sync — a real full sync
// is well under 2 minutes) and can be started over rather than blocking
// Sync Now forever.
const STALE_RUNNING_MS = 20 * 60 * 1000;
const UPSERT_BATCH_SIZE = 500;

async function getSyncState() {
  const row = (await getDb().execute('SELECT * FROM rt_candidates_sync_state WHERE id = 1')).rows[0];
  return row || null;
}

function isSyncRunning(state) {
  if (!state || state.status !== 'running') return false;
  if (!state.started_at) return false;
  return Date.now() - new Date(state.started_at).getTime() < STALE_RUNNING_MS;
}

// Same 30-days-out rule the Candidate detail view already uses client-side
// (candidateExpiringDocsCount in admin.html) — kept in sync deliberately so
// the cached count always means the same thing as what a reviewer sees when
// they actually open the candidate.
//
// isExpiry is NOT "already expired" — verified against real production data
// (2026-08-30): 18,392 of 25,818 isExpiry=true requirements have a real,
// non-expired expiryDate (most just a normal future date), vs. 7,426 that
// are genuinely expired. It means "this requirement TYPE tracks an expiry
// date at all" (as opposed to a one-time document with no expiry concept),
// not a live expired/expiring flag — a previous version of this function
// (and 3 other copies of the same logic, in routes/micropods.js and twice
// in admin.html) treated isExpiry=true alone as "expiring", which massively
// over-counted compliance issues company-wide and, in routes/micropods.js,
// pushed a huge share of Micropods' educator segmentation into "Onboarding
// Supply" that should have landed in "Available & Engaged" (confirmed live:
// fixing just this took Onboarding Supply in SA from 159 down to 80, and
// surfaced 78 real Available & Engaged educators that had been invisible).
// Real expiryDate, compared to the actual date, is the only signal that
// means anything here — excluding RT's two sentinel dates, which aren't
// real dates at all: '0001-01-01' (unset) and '9999-12-31' (this instance
// never expires).
function expiringDocsCount(candidate) {
  const soon = Date.now() + 30 * 24 * 60 * 60 * 1000;
  return (candidate.attachedRequirements || []).filter(req => {
    if (!req.expiryDate) return false;
    const dateStr = String(req.expiryDate).slice(0, 10);
    if (dateStr === '0001-01-01' || dateStr === '9999-12-31') return false;
    const t = new Date(req.expiryDate).getTime();
    return !isNaN(t) && t < soon;
  }).length;
}

function firstSuburb(candidate) {
  return (candidate.addresses || []).map(a => a.suburb).find(Boolean) || null;
}

// Fetches every candidate from RT (the slow part, ~60s+ for ~25k records)
// FIRST, entirely in memory, before touching the database at all — if RT
// times out or errors partway through, this throws and the existing cache
// is never touched, so a failed sync degrades to "a bit stale," never to
// "half overwritten." The actual DB write then happens as one transaction
// (db/database.js's transaction helper) so a crash mid-write rolls back
// completely rather than leaving some rows from this sync and some from
// the last one.
async function syncAllCandidates(triggeredBy) {
  const current = await getSyncState();
  if (isSyncRunning(current)) {
    throw new Error(`A sync is already in progress (started ${current.started_at}).`);
  }

  const db = getDb();
  const startedAt = new Date();
  await db.execute({
    sql: `UPDATE rt_candidates_sync_state SET status = 'running', started_at = ?, finished_at = NULL, error_message = NULL, triggered_by = ? WHERE id = 1`,
    args: [startedAt.toISOString(), triggeredBy || 'schedule']
  });

  let candidates;
  try {
    candidates = await rtApi.fetchAllPages('candidates', {});
  } catch (err) {
    await db.execute({
      sql: `UPDATE rt_candidates_sync_state SET status = 'failed', finished_at = now(), error_message = ? WHERE id = 1`,
      args: [err.message.slice(0, 2000)]
    });
    throw err;
  }

  const COLUMNS_PER_ROW = 12;
  try {
    await transaction(async (tx) => {
      for (let i = 0; i < candidates.length; i += UPSERT_BATCH_SIZE) {
        const batch = candidates.slice(i, i + UPSERT_BATCH_SIZE);
        const values = [];
        const rowPlaceholders = batch.map(c => {
          values.push(
            c.userId, c.firstName || null, c.lastName || null, c.email || null, c.contactNo || null,
            !!c.isActive, !!c.isDeleted, c.status ?? null, firstSuburb(c),
            c.createdDate || null, expiringDocsCount(c), JSON.stringify(c)
          );
          return `(${Array(COLUMNS_PER_ROW).fill('?').join(',')})`;
        });
        await tx.execute({
          sql: `INSERT INTO rt_candidates_cache
                  (user_id, first_name, last_name, email, contact_no, is_active, is_deleted, status, suburb, created_date, expiring_docs_count, raw)
                VALUES ${rowPlaceholders.join(',')}
                ON CONFLICT (user_id) DO UPDATE SET
                  first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email,
                  contact_no = excluded.contact_no, is_active = excluded.is_active, is_deleted = excluded.is_deleted,
                  status = excluded.status, suburb = excluded.suburb, created_date = excluded.created_date,
                  expiring_docs_count = excluded.expiring_docs_count, raw = excluded.raw, synced_at = now()`,
          args: values
        });
      }

      // Anything not touched by this sync (still carrying the OLD
      // synced_at) no longer exists in RT's result set — remove it so the
      // cache doesn't accumulate candidates RT has actually deleted.
      await tx.execute({ sql: 'DELETE FROM rt_candidates_cache WHERE synced_at < ?', args: [startedAt.toISOString()] });
    });
  } catch (err) {
    await db.execute({
      sql: `UPDATE rt_candidates_sync_state SET status = 'failed', finished_at = now(), error_message = ? WHERE id = 1`,
      args: [err.message.slice(0, 2000)]
    });
    throw err;
  }

  const finishedAt = new Date();
  await db.execute({
    sql: `UPDATE rt_candidates_sync_state SET status = 'success', finished_at = ?, candidate_count = ?, duration_ms = ? WHERE id = 1`,
    args: [finishedAt.toISOString(), candidates.length, finishedAt.getTime() - startedAt.getTime()]
  });

  return { count: candidates.length, durationMs: finishedAt.getTime() - startedAt.getTime() };
}

module.exports = { syncAllCandidates, getSyncState, isSyncRunning };
