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
//
// Also computes the 6-tier educator segmentation from Liam's Decision
// Area 1 meeting (2026-08-22) — see classifyEducator() below. Built on
// the exact same 6-month booking fetch as the original engagement split
// (not a second RT call), since the segments are a strict refinement of
// the same "did this person actually work recently" question.
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

let cache = { engagedUserIds: null, bookingAggregates: null, computedAt: 0, expiresAt: 0 };
let inFlight = null;

function lookbackStartDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - LOOKBACK_MONTHS);
  return d.toISOString().slice(0, 10);
}

// Segment definitions from Liam's Decision Area 1 meeting (2026-08-22),
// confirmed live: currently working / newly activated / available &
// engaged / warm reactivation / dormant or lapsed / onboarding supply.
const SEGMENTS = {
  currently_working: 'Currently Working',
  newly_activated: 'Newly Activated',
  available_engaged: 'Available & Engaged',
  warm_reactivation: 'Warm Reactivation',
  dormant_lapsed: 'Dormant / Lapsed',
  onboarding_supply: 'Onboarding Supply'
};
const RECENT_SHIFT_DAYS = 28; // "Currently working" cutoff, confirmed in the meeting
const WARM_WINDOW_DAYS = 90; // "Warm reactivation" -> "Dormant" cutoff, confirmed as 3 months
const NEWLY_ACTIVATED_DAYS = 28; // No activation-date field exists — created_date is the proxy
// candidate.status 4=Do Not Use, 8=Not Interested — confirmed real labels
// (see CANDIDATE_STATUS_LABELS in admin.html). Neither represents real or
// prospective supply, so both are excluded from segmentation entirely
// rather than landing in Dormant — this is the first place candidate.status
// gates Micropods supply at all.
const EXCLUDED_CANDIDATE_STATUSES = new Set([4, 8]);
// 0=Vetting Call, 2=In Progress, 5=Awaiting Activation, 10=Pending Reference —
// still-onboarding statuses, but ONLY when there's no real shift history;
// someone mid-reference-check who already has a work history isn't
// "onboarding" in the ordinary sense, so activity (checked first in
// classifyEducator) takes precedence over this. Status 9 (Student) is
// deliberately NOT in this set — the meeting specifically discussed
// Student educators doing genuine block-placement work (Sophia: "our teams
// are studying teaching, so they do really big block placements"), so a
// Student's actual activity drives their segment same as an Active (1) person.
const ONBOARDING_CANDIDATE_STATUSES = new Set([0, 2, 5, 10]);

function daysBetween(fromIso, toDate) {
  const from = new Date(fromIso);
  if (isNaN(from.getTime())) return null;
  return Math.floor((toDate.getTime() - from.getTime()) / 86400000);
}

// facts: { status, fullyCompliant, hasCurrentAvailability, createdDate }
//   — fullyCompliant/hasCurrentAvailability/createdDate come from
//   routes/micropods.js's per-candidate jsonb query, not this file.
// agg: { lastWorkedDate: 'YYYY-MM-DD', shiftsIn28Days: number } | undefined
//   — from bookingAggregates below, keyed by String(userId).
//
// Returns one of SEGMENTS' keys, or null for an excluded candidate
// (never rendered anywhere in Micropods).
//
// Order matters — first match wins. Confirmed 2026-08-22: activity
// (actual shifts) decides the segment; compliance is surfaced as a
// separate warning indicator on the row, not a segment gate — otherwise
// an educator who worked yesterday but has one lapsed certificate would
// show as "Onboarding Supply", which reads wrong operationally and
// contradicts Liam's own point that expired docs don't independently
// move someone's tier.
function classifyEducator(facts, agg) {
  if (EXCLUDED_CANDIDATE_STATUSES.has(facts.status)) return null;

  const shiftsIn28Days = agg?.shiftsIn28Days || 0;
  if (shiftsIn28Days >= 1) return 'currently_working';

  if (agg?.lastWorkedDate) {
    const daysSince = daysBetween(agg.lastWorkedDate, new Date());
    if (daysSince !== null && daysSince <= WARM_WINDOW_DAYS) return 'warm_reactivation';
    return 'dormant_lapsed';
  }

  // No meaningful shift ever seen in the 6-month window this file fetches.
  if (!facts.fullyCompliant || ONBOARDING_CANDIDATE_STATUSES.has(facts.status)) return 'onboarding_supply';

  if (facts.createdDate) {
    const daysSinceCreated = daysBetween(facts.createdDate, new Date());
    if (daysSinceCreated !== null && daysSinceCreated <= NEWLY_ACTIVATED_DAYS) return 'newly_activated';
  }

  if (facts.hasCurrentAvailability) return 'available_engaged';

  return 'dormant_lapsed';
}

async function computeEngagementData() {
  const bookings = await rtApi.fetchAllPages('bookings', { startDate: lookbackStartDate() });
  const engagedUserIds = new Set();
  const bookingAggregates = new Map(); // userId (string) -> { lastWorkedDate, shiftsIn28Days }
  const now = Date.now();
  const recentCutoff = now - RECENT_SHIFT_DAYS * 86400000;

  for (const b of bookings) {
    if (!b.assignedUserId || !ENGAGED_STATUS_IDS.has(b.statusId) || !b.bookingDate) continue;
    const bookingTime = new Date(b.bookingDate).getTime();
    if (isNaN(bookingTime) || bookingTime > now) continue; // already happened, not future-scheduled — matches admin.html's Visit Log last-booking rule

    const key = String(b.assignedUserId);
    engagedUserIds.add(key);

    const existing = bookingAggregates.get(key) || { lastWorkedDate: null, shiftsIn28Days: 0 };
    if (bookingTime >= recentCutoff) existing.shiftsIn28Days += 1;
    if (!existing.lastWorkedDate || bookingTime > new Date(existing.lastWorkedDate).getTime()) {
      existing.lastWorkedDate = b.bookingDate;
    }
    bookingAggregates.set(key, existing);
  }

  return { engagedUserIds, bookingAggregates };
}

// Concurrent callers while a fetch is already running share the same
// in-flight promise instead of each kicking off their own ~14s RT fetch —
// same reasoning as the concurrent-caller guard already used elsewhere in
// this app for other slow, cacheable RT-backed lookups.
async function getEngagedUserIds() {
  if (cache.engagedUserIds && Date.now() < cache.expiresAt) return cache;
  if (!inFlight) {
    inFlight = computeEngagementData()
      .then(({ engagedUserIds, bookingAggregates }) => {
        cache = { engagedUserIds, bookingAggregates, computedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS };
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

module.exports = {
  getEngagedUserIds, classify, ENGAGEMENT_LABELS, LOOKBACK_MONTHS,
  classifyEducator, SEGMENTS, RECENT_SHIFT_DAYS, WARM_WINDOW_DAYS, EXCLUDED_CANDIDATE_STATUSES
};
