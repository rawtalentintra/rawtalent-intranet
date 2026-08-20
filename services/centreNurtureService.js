// Turns a centre's health category into an actual worked deadline — when
// it needs its next call/visit by, and whether that's already overdue.
// Deterministic, stateless, recomputed on every read from data that
// already exists (centre_visits, health category) — same posture as
// centreHealthService.js, not a stored value that can drift.
const { lastVisitDate } = require('./centreHealthService');

const DAY_MS = 24 * 60 * 60 * 1000;

// Tunable per-health-category cadence, in days — not finalized numbers,
// just a single object to adjust. firstContactDays follows Joy's own two
// examples (Needs Attention -> within the week, Declining -> within two
// weeks), extrapolated for the rest by urgency. recurringDays is uniformly
// "monthly" (her own phrasing) since she didn't differentiate that part
// by category yet.
const NURTURE_CADENCE_DAYS = {
  needs_attention: { firstContactDays: 7, recurringDays: 30 },
  declining: { firstContactDays: 14, recurringDays: 30 },
  opportunity: { firstContactDays: 14, recurringDays: 30 },
  new_activating: { firstContactDays: 14, recurringDays: 30 },
  growing: { firstContactDays: 21, recurringDays: 30 },
  healthy: { firstContactDays: 30, recurringDays: 30 },
  dormant: { firstContactDays: 30, recurringDays: 30 }
};
const DEFAULT_CADENCE = { firstContactDays: 14, recurringDays: 30 };

// The date this feature went live. Anchors the "needs first contact"
// deadline for a centre with zero visit history so ship day doesn't
// retroactively flag most of the portfolio "overdue" against an RT signup
// date that can be years old — the same false-positive trap
// centreHealthService.js's lastVisit===null handling was built to avoid
// (94% of the portfolio would've shown needs_attention/dormant on day one
// otherwise, per that file's own comment, since visit-logging itself only
// just started existing). A centre created AFTER this date anchors to its
// own createdDate instead, so it isn't given an artificial head start.
const NURTURE_FEATURE_LAUNCH_DATE = new Date('2026-08-21T00:00:00Z');

function cadenceFor(healthCategory) {
  return NURTURE_CADENCE_DAYS[healthCategory] || DEFAULT_CADENCE;
}

// `visits` is the same raw centre_visits row array already fetched at
// every call site. `healthCategory` is computeCentreHealth(...).category —
// cadence depends on it, so this is meant to run right after
// computeCentreHealth, not standalone.
function computeCentreNurture(centre, visits, healthCategory, now = new Date()) {
  const cadence = cadenceFor(healthCategory);
  const lastContact = lastVisitDate(visits);

  if (!lastContact) {
    const createdDate = centre.createdDate ? new Date(centre.createdDate) : null;
    const anchor = createdDate && createdDate > NURTURE_FEATURE_LAUNCH_DATE ? createdDate : NURTURE_FEATURE_LAUNCH_DATE;
    const dueDate = new Date(anchor.getTime() + cadence.firstContactDays * DAY_MS);
    const overdue = now >= dueDate;
    return {
      status: overdue ? 'first_contact_overdue' : 'needs_first_contact',
      lastContactDate: null,
      dueDate: dueDate.toISOString(),
      daysUntilDue: overdue ? null : Math.ceil((dueDate - now) / DAY_MS),
      daysOverdue: overdue ? Math.floor((now - dueDate) / DAY_MS) : null,
      cadenceDays: cadence.firstContactDays,
      cadenceLabel: 'first contact'
    };
  }

  const dueDate = new Date(lastContact.getTime() + cadence.recurringDays * DAY_MS);
  const overdue = now >= dueDate;
  return {
    status: overdue ? 'recurring_overdue' : 'on_track',
    lastContactDate: lastContact.toISOString(),
    dueDate: dueDate.toISOString(),
    daysUntilDue: overdue ? null : Math.ceil((dueDate - now) / DAY_MS),
    daysOverdue: overdue ? Math.floor((now - dueDate) / DAY_MS) : null,
    cadenceDays: cadence.recurringDays,
    cadenceLabel: 'follow-up'
  };
}

module.exports = { computeCentreNurture, NURTURE_CADENCE_DAYS, DEFAULT_CADENCE, NURTURE_FEATURE_LAUNCH_DATE };
