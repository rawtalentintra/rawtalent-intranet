// Decision Area 6 — Activity Logging. These two lists are copied verbatim
// from the decision-area brief itself (not invented). The brief's own
// "Decisions required" questions were confirmed directly by Joy on
// 2026-08-24 (ahead of the live meeting actually reaching this decision
// area) — see DECISIONS_REQUIRED below and routes/centres.js's
// validateVisitFields() for what changed as a result. Only the checklist-
// item list and the exact missed/rescheduled/unsuccessful taxonomy remain
// genuinely open.
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

// Confirmed by Joy 2026-08-24 — kept as data (not just a comment) so the
// frontend's "What do these mean?"-style legend can surface the resolved
// answer as a visible note, same pattern as this codebase's other
// "known limitation" callouts (e.g. Micropods' qualification-mix caveat).
const DECISIONS_REQUIRED = [
  {
    question: 'Which fields are mandatory without making logging burdensome?',
    answer: 'Date + Channel + Activity Type, plus Outcome once Status is "Called / Visited" — everything else stays optional.'
  },
  {
    question: 'What counts as a meaningful completed call or visit?',
    answer: 'Status = "Called / Visited" — matches what centreNurtureService.js/centreHealthService.js already use for cadence.'
  },
  {
    question: 'Which activities can be captured automatically?',
    answer: 'None yet — every entry is logged by hand. A recording/transcript upload auto-fills Outcome/Notes via AI but doesn\'t create the log entry itself.'
  },
  {
    question: 'How are missed, rescheduled and unsuccessful contact attempts treated?',
    answer: 'Kept simple — reuse the existing "Rescheduled" status plus a note; no new status values were added.'
  }
];

module.exports = { CALL_ACTIVITY_TYPES, VISIT_ACTIVITY_TYPES, DECISIONS_REQUIRED };
