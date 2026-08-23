// Decision Area 6 — Activity Logging (2026-08-24). NOT YET DISCUSSED LIVE
// — the meeting hasn't reached this decision area yet. These two lists
// are copied verbatim from the decision-area brief itself (not invented),
// so they're the one part of this feature that should need NO adjustment
// once the meeting actually happens — everything else here (which fields
// are mandatory, what "meaningful" means, how missed contacts are
// treated) is the part still genuinely open; see the "Decisions required"
// list below.
//
// One shared taxonomy service (not duplicated in routes/centres.js and
// public/admin.html) so the call list and the visit list only ever live
// in one place.

const CALL_ACTIVITY_TYPES = [
  'Prospect follow-up',
  'Activation support',
  'First-booking follow-up',
  'Regular relationship check-in',
  'Growth conversation',
  'Decline investigation',
  'Service recovery',
  'Dormant reactivation'
];

const VISIT_ACTIVITY_TYPES = [
  'Prospect',
  'Centre setup',
  'First-booking welcome/merch',
  'Growth',
  'Relationship maintenance',
  'Decline investigation',
  'Service recovery',
  'Dormant reactivation'
];

// Still open per the decision-area brief itself — not answered here.
// Kept as data (not just a comment) so the frontend's "What do these
// mean?"-style legend can surface it as a visible caveat, same pattern as
// this codebase's other "known limitation" callouts (e.g. Micropods'
// qualification-mix caveat).
const DECISIONS_REQUIRED = [
  'Which fields are mandatory without making logging burdensome?',
  'What counts as a meaningful completed call or visit?',
  'Which activities can be captured automatically?',
  'How are missed, rescheduled and unsuccessful contact attempts treated?'
];

module.exports = { CALL_ACTIVITY_TYPES, VISIT_ACTIVITY_TYPES, DECISIONS_REQUIRED };
