// Classifies active candidates as "Actively Engaged" (had a real shift in
// the last 6 months) vs "Active — Not Engaged" (active in RT, but no shift
// in that window) — asked for directly (Joy: "classify the educators...
// has shift in the last 6 months" / "doesn't have shifts in the last 6
// months"). Shared between the Candidates report and Micropods so both
// surfaces agree on the same definition instead of drifting.
//
// "Had a shift" means a booking with a real assignee and a status that
// represents an actual/expected shift (Assigned or Completed) — not just
// any booking touching that candidate. A Cancelled or Failed/Unfilled
// booking was never actually worked, so it shouldn't count as engagement;
// see BOOKING_STATUS_LABELS in admin.html for where these codes came from
// (inferred from a live-data sweep, not RT's own docs).
const rtApi = require('./rtApiReportService');

const ENGAGED_STATUS_IDS = new Set([3, 5]); // Assigned, Completed
const LOOKBACK_MONTHS = 6;
// A 6-month booking fetch is ~8k+ rows and took ~14s live in testing —
// too slow to redo on every Candidates/Micropods page load, and this
// classification doesn't need to be minute-fresh (it's a 6-month rolling
// window; a booking added in the last half hour doesn't meaningfully move
// it). Cached in-memory only, same pattern as Micropods' own candidate/pod
// caches — nothing here needs to survive a restart.
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache = { engagedUserIds: null, computedAt: 0, expiresAt: 0 };
let inFlight = null;

function lookbackStartDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - LOOKBACK_MONTHS);
  return d.toISOString().slice(0, 10);
}

async function computeEngagedUserIds() {
  const bookings = await rtApi.fetchAllPages('bookings', { startDate: lookbackStartDate() });
  const engagedUserIds = new Set();
  for (const b of bookings) {
    if (b.assignedUserId && ENGAGED_STATUS_IDS.has(b.statusId)) engagedUserIds.add(String(b.assignedUserId));
  }
  return engagedUserIds;
}

// Concurrent callers while a fetch is already running share the same
// in-flight promise instead of each kicking off their own ~14s RT fetch —
// same reasoning as the concurrent-caller guard already used elsewhere in
// this app for other slow, cacheable RT-backed lookups.
async function getEngagedUserIds() {
  if (cache.engagedUserIds && Date.now() < cache.expiresAt) return cache;
  if (!inFlight) {
    inFlight = computeEngagedUserIds()
      .then(engagedUserIds => {
        cache = { engagedUserIds, computedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS };
        return cache;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

// null for inactive candidates — engagement is only meaningful for the
// active roster, per how this was asked for ("2 sets of active educators").
function classify(userId, isActive, engagedUserIds) {
  if (!isActive) return null;
  return engagedUserIds.has(String(userId)) ? 'actively_engaged' : 'active_not_engaged';
}

const ENGAGEMENT_LABELS = {
  actively_engaged: 'Actively Engaged',
  active_not_engaged: 'Active — Not Engaged'
};

module.exports = { getEngagedUserIds, classify, ENGAGEMENT_LABELS, LOOKBACK_MONTHS };
