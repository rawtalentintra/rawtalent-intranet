// Deterministic centre lifecycle/health categorisation — no AI, same style
// as documentCheckerService.js's rule-based checker and
// rtCandidatesSyncService.js's expiringDocsCount: a plain function over
// data already fetched elsewhere, not a stored enum that can drift out of
// sync with the numbers behind it.
//
// "Meaningful" bookings only count RT statusId 3 (Assigned) and 5
// (Completed) — Open/Requested/Cancelled/Failed bookings don't represent
// real activity at a centre (see BOOKING_STATUS_LABELS in admin.html's RT
// API Data Reference for the full inferred status map).
const MEANINGFUL_BOOKING_STATUSES = new Set([3, 5]);

const DAY_MS = 24 * 60 * 60 * 1000;

// Buckets one centre's bookings into the windows computeCentreHealth
// needs. Filters by rtLocationId when the centre has one (the precise
// join key — Booking.locationId matches a client's clientsLocationId);
// falls back to rtClientId for the rarer client with no locations[] on
// file — verified a real Booking record carries both fields, so this
// doesn't silently drop that centre's real activity to zero. Kept
// separate from the fetch itself so this stays pure/unit-testable.
function bucketBookingsForCentre(allBookings, { rtLocationId, rtClientId }, now = new Date()) {
  const nowMs = now.getTime();
  const forCentre = (allBookings || []).filter(b => {
    if (!MEANINGFUL_BOOKING_STATUSES.has(b.statusId) || !b.bookingDate) return false;
    return rtLocationId ? b.locationId === rtLocationId : b.clientId === rtClientId;
  });
  const bookings30d = [];
  const bookingsPrev30d = [];
  const bookings90d = [];
  for (const b of forCentre) {
    const ageMs = nowMs - new Date(b.bookingDate).getTime();
    if (ageMs < 0) continue; // future bookings don't count as "activity that happened"
    if (ageMs <= 30 * DAY_MS) bookings30d.push(b);
    else if (ageMs <= 60 * DAY_MS) bookingsPrev30d.push(b);
    if (ageMs <= 90 * DAY_MS) bookings90d.push(b);
  }
  return { bookings30d, bookingsPrev30d, bookings90d };
}

function daysSince(date, now = new Date()) {
  if (!date) return Infinity;
  return (now.getTime() - new Date(date).getTime()) / DAY_MS;
}

// Most recent completed visit, from the structured centre_visits table.
function lastVisitDate(visits) {
  const completed = (visits || []).filter(v => v.status === 'completed').map(v => new Date(v.visit_date));
  if (!completed.length) return null;
  return new Date(Math.max(...completed.map(d => d.getTime())));
}

// The latest visit's own next-step due date, if any — older visits' next
// steps are treated as superseded once a newer visit has been logged.
function latestOverdueNextStep(visits, now = new Date()) {
  const sorted = (visits || []).slice().sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date));
  const latest = sorted[0];
  if (!latest || !latest.next_step_due_date) return null;
  return new Date(latest.next_step_due_date) < now ? latest : null;
}

// First-match-wins rule order. Returns { category, reasons }. `reasons` is
// a short human-readable explanation list, same shape as
// documentCheckerService.js's outcome reasons — this is a starting rule
// set to be tuned against real portfolio data after ship, not a finished
// model (Opportunity in particular is the softest of these categories —
// RT has no "potential"/benchmark field to compare against, so it's a
// flat-bookings-but-under-engaged proxy rather than anything more precise).
//
// `centre` is the flattened RT shape from centreKeyService.flattenCentres
// ({ createdDate, isActive, ... }) — "Prospect" isn't a category here at
// all, since My Centres only lists real RT clients (already real,
// existing accounts); unsigned leads still live only in the Leads section.
//
// Booking-trend categories are checked BEFORE visit recency, and "no visit
// ever logged" (lastVisit === null — true for every real centre today,
// since centre_visits only just started existing) is treated as neutral,
// not as "45 days overdue". Verified against real data: without this, 94%
// of the actual ~1,285-centre portfolio came back "needs_attention" or
// "dormant" purely because visit logging hasn't started yet, even for
// centres with strongly growing real booking activity — which would make
// the health signal useless on day one. A stale-visit penalty should only
// apply once there's an actual last visit to be stale relative to.
function computeCentreHealth(centre, { visits = [], bookings30d = [], bookingsPrev30d = [], bookings90d = [] } = {}, now = new Date()) {
  const reasons = [];

  if (centre.isActive === false) {
    return { category: 'dormant', reasons: ['Marked inactive in RT.'] };
  }

  const daysSinceCreated = daysSince(centre.createdDate, now);
  const lastVisit = lastVisitDate(visits);
  const daysSinceVisit = lastVisit ? daysSince(lastVisit, now) : null;
  const overdueStep = latestOverdueNextStep(visits, now);

  if (daysSinceCreated <= 60 && bookings90d.length < 5) {
    reasons.push(`New in RT ${Math.round(daysSinceCreated)} days ago, ${bookings90d.length} booking(s) so far — still activating.`);
    return { category: 'new_activating', reasons };
  }

  if (bookings90d.length === 0) {
    reasons.push('No bookings in the last 90 days.');
    return { category: 'dormant', reasons };
  }

  const MIN_TREND_FLOOR = 4;
  if (bookingsPrev30d.length >= MIN_TREND_FLOOR && bookings30d.length < bookingsPrev30d.length * 0.5) {
    reasons.push(`Bookings dropped from ${bookingsPrev30d.length} to ${bookings30d.length} over the last 30 days.`);
    return { category: 'declining', reasons };
  }

  if (bookings30d.length === 0 && bookingsPrev30d.length > 0) {
    reasons.push('No bookings in the last 30 days after prior activity.');
    return { category: 'needs_attention', reasons };
  }
  if (overdueStep) {
    reasons.push(`Next step "${overdueStep.next_step || 'follow-up'}" was due ${overdueStep.next_step_due_date}.`);
    return { category: 'needs_attention', reasons };
  }
  if (daysSinceVisit !== null && daysSinceVisit > 45) {
    reasons.push(`No visit logged in ${Math.round(daysSinceVisit)} days.`);
    return { category: 'needs_attention', reasons };
  }

  if (bookingsPrev30d.length > 0 && bookings30d.length > bookingsPrev30d.length * 1.2) {
    reasons.push(`Bookings grew from ${bookingsPrev30d.length} to ${bookings30d.length} over the last 30 days.`);
    return { category: 'growing', reasons };
  }

  if (daysSinceVisit !== null && daysSinceVisit > 60) {
    reasons.push('Steady booking volume, but no recent relationship visit — likely under-engaged.');
    return { category: 'opportunity', reasons };
  }

  reasons.push('Booking activity looks steady.' + (lastVisit ? '' : ' No visit logged yet in this system.'));
  return { category: 'healthy', reasons };
}

module.exports = { computeCentreHealth, bucketBookingsForCentre, MEANINGFUL_BOOKING_STATUSES };
