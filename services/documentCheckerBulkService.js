const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

// A bulk sweep "stuck" in 'running' for longer than this is treated as dead
// (a crashed/redeployed process, not an actual slow sweep) and can be
// started over rather than blocking the button forever — same rationale
// and same-shaped guard as rt_candidates_sync_state's STALE_RUNNING_MS.
const STALE_RUNNING_MS = 30 * 60 * 1000;

// Hard cap on how many candidates one sweep touches — each candidate can
// mean several real OCR checks (several seconds each), so an unbounded
// sweep across RT's full ~25k candidates would run for hours and tie up
// this server's one-check-at-a-time child-process model the whole time.
// Bounded, sequential, and re-runnable (running it again picks up whatever
// wasn't reached, since RECHECK_COOLDOWN_DAYS below skips anything already
// freshly checked) rather than one giant unattended job.
const MAX_BULK_CANDIDATES = 200;

// A document already checked this recently isn't re-checked again by a
// sweep — only genuinely new or stale results are worth spending an OCR
// pass on. Doesn't affect the single "Check Document"/"Re-check" button,
// which always runs on demand regardless of this.
const RECHECK_COOLDOWN_DAYS = 14;

// Same mapping as admin.html's CANDIDATE_REGION_TO_STATE (client-side, used
// to show a candidate's state in the UI) — duplicated here because this
// runs server-side against the RT cache with no candidate-facing HTTP
// request involved at all. RT's region IDs for the 8 AU states are about as
// stable a reference table as exists in this whole integration; if this
// ever needs changing, admin.html's copy needs the same change.
const CANDIDATE_REGION_TO_STATE = { 1: 'NSW', 2: 'QLD', 3: 'TAS', 4: 'VIC', 5: 'SA', 6: 'WA', 7: 'NT', 8: 'ACT' };

function candidateState(candidate) {
  for (const addr of candidate.addresses || []) {
    const state = CANDIDATE_REGION_TO_STATE[addr.regionId];
    if (state) return state;
  }
  return null;
}

// Real finding (2026-09-09): RT's attachedRequirements[] is NOT one row per
// uploaded document — a real candidate (Sarah Churchill) had 248 entries,
// including ~40 separate "Police Check" rows all sharing the exact same
// documentPath and expiryDate, differing only by userDocumentDetailId.
// RT appears to attach the same requirement/document reference once per
// booking/shift it was needed for, not once per actual upload. Without
// this, a bulk sweep would OCR the literal identical file dozens of times
// per candidate — wasteful, slow, and pointless. Kept to the FIRST
// attachedRequirement per unique documentPath; a duplicate
// userDocumentDetailId that gets skipped this way just won't get its own
// document_checks row (an honest, acceptable gap given how messy this data
// shape is — the single "Check Document" button per candidate isn't
// changed by this, only the bulk sweep's own document selection).
function dedupeByDocumentPath(requirements) {
  const seen = new Set();
  const deduped = [];
  for (const req of requirements) {
    const key = req.documentPath || `no-path-${req.userDocumentDetailId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(req);
  }
  return deduped;
}

async function getLatestBulkRun() {
  const row = (await getDb().execute('SELECT * FROM document_check_bulk_runs ORDER BY started_at DESC LIMIT 1')).rows[0];
  return row || null;
}

function isBulkRunning(row) {
  if (!row || row.status !== 'running') return false;
  return Date.now() - new Date(row.started_at).getTime() < STALE_RUNNING_MS;
}

// Kicks off the sweep in the background and returns immediately with the
// new run's id — the actual work (runBulkCheck below) is NOT awaited here,
// same fire-and-forget + poll pattern as rt_candidates_sync_state
// (routes/reports.js's /candidates/sync). A real sweep can run for many
// minutes; nothing should hold an HTTP request open that long.
async function startBulkRun(stateFilter, triggeredBy, deps) {
  const db = getDb();
  const runId = uuidv4();
  try {
    await db.execute({
      sql: `INSERT INTO document_check_bulk_runs (id, state_filter, status, triggered_by) VALUES (?, ?, 'running', ?)`,
      args: [runId, stateFilter || 'ALL', triggeredBy]
    });
  } catch (err) {
    // Real bug (found 2026-09-09, stress-testing): the caller's own
    // getLatestBulkRun()+isBulkRunning() pre-check (routes/documentChecker.js)
    // is only a fast, friendly path — reproduced empirically that two
    // concurrent "start a sweep" calls can both pass that check before
    // either commits, both actually starting a real sweep at once. The
    // partial unique index on (status) WHERE status='running' (schema.sql)
    // is what actually guarantees only one can exist; this INSERT is
    // expected to occasionally fail with a unique-violation under real
    // concurrent load, and that's the correct, intended outcome — turned
    // into the same friendly error the pre-check already produces for the
    // common (non-racing) case, not a raw Postgres error.
    if (err.message?.includes('duplicate key') || err.code === '23505') {
      throw new Error('A bulk sweep is already in progress.');
    }
    throw err;
  }
  runBulkCheck(runId, stateFilter || 'ALL', deps).catch(err => console.error('Bulk document check sweep error:', err.message));
  return runId;
}

// Bulk operations read from rt_candidates_cache (the nightly-synced local
// mirror) rather than live-fetching each candidate individually from RT —
// the same staleness trade-off the Candidates report already accepts for
// browsing/search speed (see rt_candidates_cache's own schema.sql comment).
// Fetching up to a few hundred candidates live from RT one at a time would
// be far slower and puts real load on RT's API for a sweep that's already
// bounded and re-runnable; a single candidate's Document Checker view still
// always fetches live regardless; this only affects which candidates a
// sweep decides to touch and what their attachedRequirements look like at
// sweep time; the actual compliance DECISION for each document still comes
// from the real document fetched fresh from its own real S3 documentPath.
const CANDIDATE_POOL_SIZE = 3000;

async function runBulkCheck(runId, stateFilter, { performDocumentCheck, REQUIREMENT_NAME_TO_TYPE }) {
  const db = getDb();
  try {
    const pool = (await db.execute({
      sql: `SELECT user_id, first_name, last_name, raw FROM rt_candidates_cache
            WHERE is_active = true AND (is_deleted IS NOT TRUE)
              AND coalesce(jsonb_array_length(raw->'attachedRequirements'), 0) > 0
            ORDER BY expiring_docs_count DESC
            LIMIT ?`,
      args: [CANDIDATE_POOL_SIZE]
    })).rows;

    const candidates = (stateFilter === 'ALL' ? pool : pool.filter(c => candidateState(c.raw) === stateFilter)).slice(0, MAX_BULK_CANDIDATES);

    await db.execute({ sql: `UPDATE document_check_bulk_runs SET candidates_total = ? WHERE id = ?`, args: [candidates.length, runId] });

    let processed = 0, checked = 0, flagged = 0;
    for (const candidate of candidates) {
      const state = candidateState(candidate.raw);
      const requirements = dedupeByDocumentPath(candidate.raw?.attachedRequirements || []);
      for (const req of requirements) {
        const documentType = REQUIREMENT_NAME_TO_TYPE[req.requirementName];
        if (!documentType || !req.documentPath) continue;

        // Skip anything already checked recently — see
        // RECHECK_COOLDOWN_DAYS above.
        const recent = (await db.execute({
          sql: `SELECT id FROM document_checks WHERE user_document_detail_id = ? AND created_at > now() - interval '${RECHECK_COOLDOWN_DAYS} days' LIMIT 1`,
          args: [req.userDocumentDetailId]
        })).rows[0];
        if (recent) continue;

        try {
          const result = await performDocumentCheck({
            candidateId: candidate.user_id,
            candidateName: [candidate.first_name, candidate.last_name].filter(Boolean).join(' '),
            candidateState: state,
            userDocumentDetailId: req.userDocumentDetailId,
            requirementName: req.requirementName,
            documentPath: req.documentPath,
            checkedByEmail: 'bulk-sweep@system',
            checkedByName: 'Bulk Compliance Sweep',
            bulkRunId: runId
          });
          checked++;
          if (result.outcome !== 'valid') flagged++;
        } catch (err) {
          // One bad document (a dead S3 link, an unsupported file type)
          // doesn't stop the whole sweep — logged and skipped, same as any
          // other per-document failure this feature already tolerates.
          console.error(`Bulk check failed for candidate ${candidate.user_id}, doc ${req.userDocumentDetailId}: ${err.message}`);
        }
      }
      processed++;
      // Progress updated every candidate (not every document) — frequent
      // enough for a smooth-looking progress bar without a DB write per
      // document on top of the one performDocumentCheck already does.
      await db.execute({
        sql: `UPDATE document_check_bulk_runs SET candidates_processed = ?, documents_checked = ?, documents_flagged = ? WHERE id = ?`,
        args: [processed, checked, flagged, runId]
      });
    }

    await db.execute({ sql: `UPDATE document_check_bulk_runs SET status = 'success', finished_at = now() WHERE id = ?`, args: [runId] });
  } catch (err) {
    await db.execute({
      sql: `UPDATE document_check_bulk_runs SET status = 'failed', finished_at = now(), error_message = ? WHERE id = ?`,
      args: [err.message?.slice(0, 2000), runId]
    });
  }
}

module.exports = { getLatestBulkRun, isBulkRunning, startBulkRun, MAX_BULK_CANDIDATES, RECHECK_COOLDOWN_DAYS };
