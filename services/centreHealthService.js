// Deterministic centre lifecycle/health categorisation — no AI, same style
// as documentCheckerService.js's rule-based checker and
// rtCandidatesSyncService.js's expiringDocsCount: a plain function over
// data already fetched elsewhere, not a stored enum that can drift out of
// sync with the numbers behind it.
//
// Decision Area 3 — Centre Health and Account Cadence (2026-08-22 meeting,
// Liam/Justine/Gwen/Sophia/Joy) confirmed the numeric thresholds this file
// used to leave as placeholders — see individual comments below for each
// one and its transcript timestamp.
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

// Most recent meaningful booking date across WHATEVER window the caller's
// `allBookings` array actually covers — the 12-month dormancy check below
// needs a real last-booking-date, not just a boolean "any in 90 days",
// so this is fed a wider (366-day) fetch by routes/centres.js, kept as its
// own separate cache rather than widening the shared 100-day one (same
// "different time window = separate cache" convention
// educatorEngagementService.js already uses for its own 6-month fetch).
function lastMeaningfulBookingDate(allBookings, { rtLocationId, rtClientId }, now = new Date()) {
  const nowMs = now.getTime();
  let latest = null;
  for (const b of (allBookings || [])) {
    if (!MEANINGFUL_BOOKING_STATUSES.has(b.statusId) || !b.bookingDate) continue;
    if (rtLocationId ? b.locationId !== rtLocationId : b.clientId !== rtClientId) continue;
    const d = new Date(b.bookingDate);
    if (d.getTime() > nowMs) continue; // future bookings aren't "activity that happened" yet
    if (!latest || d > latest) latest = d;
  }
  return latest;
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

// Escalation exception (Decision Area 3, @1:02:28-@1:03:26 — Liam: "if
// there's an issue or an allegation or something that's been raised, that
// comes straight to the top"). Reuses the existing centre_visits.outcome
// field (already captured by "Log a Call/Visit" today) rather than adding
// a new column — 'issue_raised' is the one outcome value serious enough to
// mean this, matching the schema comment's own outcome enum. Only the
// LATEST visit is checked (same "superseded by a newer visit" rule
// latestOverdueNextStep already uses) — a resolved issue from three visits
// ago shouldn't keep flashing red forever once something's been logged
// since. 'concern' (milder) deliberately does NOT auto-escalate — that's
// an ordinary Needs Attention/Declining signal, not a top-of-queue one.
function latestVisitIsEscalated(visits) {
  const sorted = (visits || []).slice().sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date));
  return (sorted[0]?.outcome === 'issue_raised') || false;
}

// The actual escalation text, not just the boolean above — added
// 2026-09-03 (Liam, on a call with Joy: "Sofia and your teams" should be
// able to escalate a centre as a note that "shows up as an escalation for
// workforce partners"). Redoes the identical latest-visit sort rather than
// changing latestVisitIsEscalated's own return shape — that function has
// exactly one call site today, but it's a load-bearing boolean threaded
// through health/nurture computation everywhere, not worth risking for
// this. Null whenever the latest visit isn't actually an escalation, or
// has no notes recorded.
function latestEscalationNote(visits) {
  const sorted = (visits || []).slice().sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date));
  const latest = sorted[0];
  return (latest?.outcome === 'issue_raised' && latest.notes) || null;
}

// Strategic / High Volume (Decision Area 3, @1:01:12-@1:01:41 — Justine:
// "Yarra Road... high volume, that could be like weekly bookings", Gwen:
// "of two or more per week"). A modifier, not its own health category — a
// Strategic centre can be Healthy, Growing, Declining, etc. and still be
// Strategic; it changes the CADENCE applied (see centreNurtureService.js),
// not which of the 7 categories the centre lands in. ~13 weeks in a
// 90-day window, so >=2/week works out to >=26 bookings in that window.
const STRATEGIC_BOOKINGS_90D_THRESHOLD = 26;

// Dormancy inactivity window (Decision Area 3, @1:00:21-@1:01:12 — Liam
// proposed 12 weeks, Justine/Gwen both independently said "12 months" and
// Liam confirmed "All right, 12 months"). Replaces this file's previous
// 90-day-no-bookings proxy for dormancy, which was actually just the
// health-window floor, not a real dormancy signal — see
// lastMeaningfulBookingDate's comment for why an accurate 12-month check
// needs its own wider bookings fetch, separate from the 90-day windows
// bucketBookingsForCentre computes.
const DORMANCY_DAYS = 365;

// First-match-wins rule order. Returns { category, reasons, isStrategic,
// isEscalated }. `reasons` is a short human-readable explanation list,
// same shape as documentCheckerService.js's outcome reasons — this is a
// starting rule set to be tuned against real portfolio data after ship,
// not a finished model (Opportunity in particular is the softest of these
// categories — RT has no "potential"/benchmark field to compare against,
// so it's a flat-bookings-but-under-engaged proxy rather than anything
// more precise).
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
function computeCentreHealth(centre, { visits = [], bookings30d = [], bookingsPrev30d = [], bookings90d = [], lastBookingDate = null } = {}, now = new Date()) {
  const reasons = [];
  const isStrategic = bookings90d.length >= STRATEGIC_BOOKINGS_90D_THRESHOLD;
  const isEscalated = latestVisitIsEscalated(visits);
  const escalationNote = isEscalated ? latestEscalationNote(visits) : null;

  if (centre.isActive === false) {
    return { category: 'dormant', reasons: ['Marked inactive in RT.'], isStrategic, isEscalated, escalationNote };
  }

  const daysSinceCreated = daysSince(centre.createdDate, now);
  const lastVisit = lastVisitDate(visits);
  const daysSinceVisit = lastVisit ? daysSince(lastVisit, now) : null;
  const overdueStep = latestOverdueNextStep(visits, now);
  const daysSinceLastBooking = lastBookingDate ? daysSince(lastBookingDate, now) : null;

  if (daysSinceCreated <= 60 && bookings90d.length < 5) {
    reasons.push(`New in RT ${Math.round(daysSinceCreated)} days ago, ${bookings90d.length} booking(s) so far — still activating.`);
    return { category: 'new_activating', reasons, isStrategic, isEscalated, escalationNote };
  }

  // Confirmed 12-month dormancy window — checked against the real last
  // booking date (from a 366-day fetch), not just the 90-day bucket, so a
  // centre asleep for e.g. 150 days is correctly caught here rather than
  // silently falling through to "healthy" because no visit was logged to
  // compare against (the same false-positive trap this file's header
  // comment already describes for stale-visit checks).
  if (daysSinceLastBooking !== null && daysSinceLastBooking >= DORMANCY_DAYS) {
    reasons.push(`No booking in ${Math.round(daysSinceLastBooking)} days (12+ months) — dormant.`);
    return { category: 'dormant', reasons, isStrategic, isEscalated, escalationNote };
  }
  // No booking on record anywhere in the 366-day lookback at all, and not
  // a brand-new centre — nothing recent enough to call this anything but
  // dormant either.
  if (lastBookingDate === null && daysSinceCreated > 60) {
    reasons.push('No booking on record in the last 12 months.');
    return { category: 'dormant', reasons, isStrategic, isEscalated, escalationNote };
  }

  // Zero bookings in the last 90 days but a real booking happened more
  // recently than the 12-month dormancy cutoff — heading toward dormant,
  // not there yet. This centre used to fall through to "healthy"/
  // "opportunity" by default (bookings90d.length===0 only ever triggered
  // dormant before), which was wrong: "bookings have fallen materially
  // relative to the centre's established pattern" (Declining's own
  // definition) describes this gap better than treating it as fine.
  if (bookings90d.length === 0) {
    reasons.push(`No bookings in the last 90 days (last booking ${daysSinceLastBooking !== null ? Math.round(daysSinceLastBooking) + ' days ago' : 'unknown'}).`);
    return { category: 'declining', reasons, isStrategic, isEscalated, escalationNote };
  }

  // Booking-volume decline, weighted by the centre's own established
  // volume rather than a flat percentage alone (Decision Area 3,
  // @1:00:21-@1:04:34 — Liam: a centre with one booking every few months
  // dropping to zero is a 100% decline but "not something we need to pay
  // attention to immediately"; Brahma Lodge dropping from ~8 bookings/day
  // to ~2/day is a smaller percentage move but real and worth flagging.
  // MIN_TREND_FLOOR already implements "don't flag a near-zero centre's
  // total drop to zero" — a centre with fewer than 4 bookings in the
  // comparison window never reaches this check at all).
  const MIN_TREND_FLOOR = 4;
  if (bookingsPrev30d.length >= MIN_TREND_FLOOR && bookings30d.length < bookingsPrev30d.length * 0.5) {
    reasons.push(`Bookings dropped from ${bookingsPrev30d.length} to ${bookings30d.length} over the last 30 days.`);
    return { category: 'declining', reasons, isStrategic, isEscalated, escalationNote };
  }

  if (bookings30d.length === 0 && bookingsPrev30d.length > 0) {
    reasons.push('No bookings in the last 30 days after prior activity.');
    return { category: 'needs_attention', reasons, isStrategic, isEscalated, escalationNote };
  }
  if (overdueStep) {
    reasons.push(`Next step "${overdueStep.next_step || 'follow-up'}" was due ${overdueStep.next_step_due_date}.`);
    return { category: 'needs_attention', reasons, isStrategic, isEscalated, escalationNote };
  }
  if (daysSinceVisit !== null && daysSinceVisit > 45) {
    reasons.push(`No visit logged in ${Math.round(daysSinceVisit)} days.`);
    return { category: 'needs_attention', reasons, isStrategic, isEscalated, escalationNote };
  }

  if (bookingsPrev30d.length > 0 && bookings30d.length > bookingsPrev30d.length * 1.2) {
    reasons.push(`Bookings grew from ${bookingsPrev30d.length} to ${bookings30d.length} over the last 30 days.`);
    return { category: 'growing', reasons, isStrategic, isEscalated, escalationNote };
  }

  if (daysSinceVisit !== null && daysSinceVisit > 60) {
    reasons.push('Steady booking volume, but no recent relationship visit — likely under-engaged.');
    return { category: 'opportunity', reasons, isStrategic, isEscalated, escalationNote };
  }

  reasons.push('Booking activity looks steady.' + (lastVisit ? '' : ' No visit logged yet in this system.'));
  return { category: 'healthy', reasons, isStrategic, isEscalated, escalationNote };
}

module.exports = {
  computeCentreHealth, bucketBookingsForCentre, lastMeaningfulBookingDate, MEANINGFUL_BOOKING_STATUSES, lastVisitDate,
  STRATEGIC_BOOKINGS_90D_THRESHOLD, DORMANCY_DAYS
};
