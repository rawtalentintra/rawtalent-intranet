const { getDb } = require('../db/database');
const rtApi = require('./rtApiReportService');

// ── HeartBeat-vs-RT data accuracy check (2026-09-13) ─────────────────────
// Joy: "I need an actual section checking if our HB data matches what's
// on the portal." rt_candidates_cache (nightly-synced — see
// rtCandidatesSyncService.js) is what almost every list/search/bulk tool
// in this app actually reads, but RT Portal itself always reflects RT's
// own live data, which can change any time between syncs. This compares
// the cached row against a genuinely fresh pull straight from RT's own
// API (rtApiReportService.fetchById — the same "getcandidatebyid"
// endpoint Portal itself is ultimately backed by), not a scrape of
// Portal's own rendered page — confirmed with Joy directly that comparing
// against RT's live API (no Portal login needed, nothing fragile to
// screen-scrape) is what she actually wants, not a Portal UI automation.
// Purely a read/report, per this app's own RT read-only boundary — never
// writes anything back to either side.

// Scalar top-level fields worth comparing directly — chosen from the real
// discrepancies already found and fixed this session (Enabled/Disabled vs
// Status confusion, stale cache concerns), not an exhaustive dump of every
// field RT returns.
const SCALAR_FIELDS = [
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'userName', label: 'Username' },
  { key: 'email', label: 'Email' },
  { key: 'contactNo', label: 'Phone' },
  { key: 'isActive', label: 'Enabled (isActive)' },
  { key: 'isDeleted', label: 'Is Deleted' },
  { key: 'status', label: 'Status (vetting stage)' }
];

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'string') return v.trim();
  return v;
}

function valuesDiffer(a, b) {
  return JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b));
}

function diffScalarFields(cached, live) {
  return SCALAR_FIELDS
    .map(f => ({ field: f.label, key: f.key, cachedValue: cached?.[f.key] ?? null, liveValue: live?.[f.key] ?? null }))
    .filter(d => valuesDiffer(d.cachedValue, d.liveValue));
}

// Matched by userDocumentDetailId (the real per-requirement row id, stable
// across syncs) — comparing expiryDate/documentNumber/isReviewed, the
// exact fields this session's own real bugs (sentinel dates, WWCC number
// format) have all lived in. Requirements present in only one side are
// their own, separate kind of mismatch (added/removed since last sync),
// not a field-level difference.
function diffRequirements(cachedReqs, liveReqs) {
  const cachedById = new Map((cachedReqs || []).map(r => [r.userDocumentDetailId, r]));
  const liveById = new Map((liveReqs || []).map(r => [r.userDocumentDetailId, r]));
  const allIds = new Set([...cachedById.keys(), ...liveById.keys()]);
  const fieldMismatches = [];
  const onlyInCache = [];
  const onlyInLive = [];

  for (const id of allIds) {
    const c = cachedById.get(id);
    const l = liveById.get(id);
    if (c && !l) { onlyInCache.push({ requirementName: c.requirementName, userDocumentDetailId: id }); continue; }
    if (l && !c) { onlyInLive.push({ requirementName: l.requirementName, userDocumentDetailId: id }); continue; }
    ['expiryDate', 'documentNumber', 'isReviewed', 'isMandatory'].forEach(key => {
      if (valuesDiffer(c[key], l[key])) {
        fieldMismatches.push({
          requirementName: c.requirementName, userDocumentDetailId: id, field: key,
          cachedValue: c[key] ?? null, liveValue: l[key] ?? null
        });
      }
    });
  }
  return { fieldMismatches, onlyInCache, onlyInLive };
}

async function compareCandidateData(userId) {
  const db = getDb();
  const cachedRow = (await db.execute({ sql: 'SELECT raw, synced_at FROM rt_candidates_cache WHERE user_id = ?', args: [userId] })).rows[0];
  const live = await rtApi.fetchById('candidates', userId);
  if (!live) throw new Error('RT has no candidate with this ID.');
  const cached = cachedRow?.raw || null;

  const scalarMismatches = cached ? diffScalarFields(cached, live) : [];
  const { fieldMismatches, onlyInCache, onlyInLive } = cached
    ? diffRequirements(cached.attachedRequirements, live.attachedRequirements)
    : { fieldMismatches: [], onlyInCache: [], onlyInLive: [] };

  const totalDifferences = scalarMismatches.length + fieldMismatches.length + onlyInCache.length + onlyInLive.length;

  return {
    userId,
    name: [live.firstName, live.lastName].filter(Boolean).join(' ') || 'Unnamed candidate',
    inCache: !!cachedRow,
    cacheSyncedAt: cachedRow?.synced_at || null,
    matches: !!cachedRow && totalDifferences === 0,
    totalDifferences,
    scalarMismatches,
    requirementMismatches: fieldMismatches,
    requirementsOnlyInCache: onlyInCache,
    requirementsOnlyInLive: onlyInLive
  };
}

module.exports = { compareCandidateData };
