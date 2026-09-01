// Turns a centre's health category into an actual worked deadline — when
// it needs its next call/visit by, and whether that's already overdue.
// Deterministic, stateless, recomputed on every read from data that
// already exists (centre_visits, health category) — same posture as
// centreHealthService.js, not a stored value that can drift.
const { lastVisitDate } = require('./centreHealthService');

const DAY_MS = 24 * 60 * 60 * 1000;

// Per-health-category cadence, in days — confirmed live in the Decision
// Area 3 meeting (2026-08-22, Liam/Justine/Gwen/Sophia/Joy), replacing
// this file's previous placeholder numbers (its own comment used to say
// "not finalized... didn't differentiate [recurring] yet").
//
// The proposed cadence document gives Healthy/Strategic/New-Activating
// separate call-cadence and visit-cadence numbers (e.g. Healthy: "call
// every 60-90 days; visit at least every 90 days"). centre_visits has no
// column distinguishing a phone call from an in-person visit today (the
// feature is literally named "Log a Call/Visit" — one combined event
// type) — splitting that is a real schema/UI change beyond this pass, so
// this uses ONE combined "next touchpoint" cadence per category, set to
// the TIGHTER of the two proposed numbers so the more frequent
// requirement always wins rather than silently loosening to the looser one.
//
// firstContactDays anchors a centre with NO visit ever logged (see
// NURTURE_FEATURE_LAUNCH_DATE below); recurringDays anchors one measured
// from its last logged visit.
const NURTURE_CADENCE_DAYS = {
  // Declining: "Call within seven days of the alert" (Liam's own document;
  // Gwen flagged live that 7 days felt tight for her SA portfolio, but no
  // replacement number was actually locked in afterward, so the written 7
  // stands until amended).
  declining: { firstContactDays: 7, recurringDays: 7 },
  // Needs Attention: "a specific action is required" — same urgency tier
  // as Declining, not a separate number in the source document.
  needs_attention: { firstContactDays: 7, recurringDays: 7 },
  // Growing: "Prompt growth conversation" — prompt, not immediate; visit
  // itself is opportunistic ("when there is an opportunity to deepen the
  // relationship"), not on a fixed clock, so this is a backstop ceiling
  // rather than a real target.
  growing: { firstContactDays: 7, recurringDays: 14 },
  // New/Activating: "Immediate setup support" before first login/booking,
  // then "support until second booking" — approximated as a fast initial
  // window tightening to a steady fortnightly check-in once the centre has
  // its footing, since centre_visits can't yet distinguish "before 1st
  // booking" from "between 1st and 2nd" without a schema change.
  new_activating: { firstContactDays: 3, recurringDays: 14 },
  // Opportunity: no explicit number in the source document — left as the
  // existing reasonable middle-ground pending a real decision.
  opportunity: { firstContactDays: 14, recurringDays: 14 },
  // Healthy active: "Meaningful call every 60-90 days; visit at least
  // every 90 days" — 75 is the midpoint of the call range, which is also
  // the tighter of the two numbers, so it's the one used.
  healthy: { firstContactDays: 30, recurringDays: 75 }
  // 'dormant' is deliberately absent — see computeCentreNurture's
  // reactivation-workflow branch below. No blanket cadence at all
  // (Liam: "A blanket visit cadence for every dormant historical centre
  // would consume time without necessarily creating value").
};
const DEFAULT_CADENCE = { firstContactDays: 14, recurringDays: 30 };

// Strategic/High Volume (>=2 bookings/week, see centreHealthService.js) —
// "faster intervention when required" (Decision Area 3's own cadence
// doc). A cross-cutting modifier, not its own category: tightens whatever
// cadence the health category would otherwise give, but never loosens
// one that's already tighter (e.g. a Strategic-but-Declining centre keeps
// Declining's 7-day cadence, not a looser Strategic one).
const STRATEGIC_MAX_CADENCE_DAYS = 30;

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

function cadenceFor(healthCategory, isStrategic) {
  const base = NURTURE_CADENCE_DAYS[healthCategory] || DEFAULT_CADENCE;
  if (!isStrategic) return base;
  return {
    firstContactDays: Math.min(base.firstContactDays, STRATEGIC_MAX_CADENCE_DAYS),
    recurringDays: Math.min(base.recurringDays, STRATEGIC_MAX_CADENCE_DAYS)
  };
}

// `visits` is the same raw centre_visits row array already fetched at
// every call site. `healthCategory`/`isStrategic`/`isEscalated` come from
// computeCentreHealth(...) — cadence depends on all three, so this is
// meant to run right after computeCentreHealth, not standalone.
function computeCentreNurture(centre, visits, healthCategory, now = new Date(), { isStrategic = false, isEscalated = false } = {}) {
  // Escalation exception (Decision Area 3, @1:02:28 — "if there's an issue
  // or an allegation... that comes straight to the top") outranks every
  // other cadence rule, including Dormant's own no-cadence exception —
  // an escalated dormant centre still needs to be looked at immediately.
  if (isEscalated) {
    return {
      status: 'escalated', lastContactDate: lastVisitDate(visits)?.toISOString() || null,
      dueDate: now.toISOString(), daysUntilDue: null, daysOverdue: 0,
      cadenceDays: 0, cadenceLabel: 'escalation — immediate'
    };
  }

  // Dormant: no blanket cadence at all (see NURTURE_CADENCE_DAYS' comment)
  // — a distinct status, excluded from the automatic due-for-routing pool
  // (routes/centres.js's getDueCentreStops) rather than surfaced as
  // "overdue" alongside everything else. Still fully visible/actionable
  // from My Centres' own health filter — "visit only where previous value
  // or current opportunity justifies it" means a deliberate choice, not
  // an automatic one.
  if (healthCategory === 'dormant') {
    const lastContact = lastVisitDate(visits);
    return {
      status: 'reactivation_candidate', lastContactDate: lastContact ? lastContact.toISOString() : null,
      dueDate: null, daysUntilDue: null, daysOverdue: null,
      cadenceDays: null, cadenceLabel: 'reactivation workflow — no fixed cadence'
    };
  }

  const cadence = cadenceFor(healthCategory, isStrategic);
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

  // Smart Routing auto-deprioritization (Aug 24 meeting, Liam/Justine/Joy):
  // "if there's a follow-up, they can stay in the mix" — a completed
  // call/visit that left a next_step open must NOT reset the centre onto
  // the ordinary weeks/months-long recurring cadence below, or a real
  // outstanding action would silently vanish from Smart Routing's due
  // pool right when it's most likely to be forgotten. Only the LATEST
  // completed visit counts (same "superseded by a newer visit" rule
  // latestOverdueNextStep/latestVisitIsEscalated already use in
  // centreHealthService.js) — once a later visit closes things out
  // without leaving its own next_step, the centre falls through to the
  // normal cadence below exactly as before.
  //
  // No next_step_due_date on that follow-up (a rep can leave it blank)
  // is treated as due now rather than parked indefinitely — the whole
  // point of this branch is "known outstanding work", not "eventually".
  const sortedCompleted = (visits || [])
    .filter(v => v.status === 'completed')
    .sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date));
  const openFollowUp = sortedCompleted[0]?.next_step?.trim() ? sortedCompleted[0] : null;
  if (openFollowUp) {
    const dueDate = openFollowUp.next_step_due_date ? new Date(openFollowUp.next_step_due_date) : now;
    const overdue = now >= dueDate;
    return {
      status: overdue ? 'follow_up_overdue' : 'follow_up_pending',
      lastContactDate: lastContact.toISOString(),
      dueDate: dueDate.toISOString(),
      daysUntilDue: overdue ? null : Math.ceil((dueDate - now) / DAY_MS),
      daysOverdue: overdue ? Math.floor((now - dueDate) / DAY_MS) : null,
      cadenceDays: null,
      cadenceLabel: 'follow-up owed'
    };
  }

  // No open follow-up — this is the actual "drops out of the pool for a
  // while" deprioritization Liam described. Uses the existing per-category
  // cadence (7-90 days depending on health/strategic status, see
  // NURTURE_CADENCE_DAYS above) rather than a flat 3 months for every
  // centre — his "once every three months" was describing the general
  // shape of the rule, not overriding the tighter Declining/Needs
  // Attention cadences already confirmed live two days earlier (Decision
  // Area 3, 2026-08-22); a Declining centre sitting quiet for 3 months
  // because nothing needed following up would defeat the point of that
  // cadence. Flag this if a flat 90 days for everyone was actually wanted.
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

module.exports = { computeCentreNurture, NURTURE_CADENCE_DAYS, DEFAULT_CADENCE, STRATEGIC_MAX_CADENCE_DAYS, NURTURE_FEATURE_LAUNCH_DATE };
