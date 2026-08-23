// Decision Area 5 — Client Acquisition & Activation, "full client
// timeline" requirement (2026-08-24). NOT YET DISCUSSED LIVE — the actual
// meeting hasn't covered this decision area in detail yet. This is a
// best-guess v1 built from the patterns Decision Areas 1-5 already
// confirmed (favour deriving from real data over storing a shaky proxy —
// see advertisingOpportunityService.js/territoryStrategyService.js), not
// a locked design. Every assumption below is flagged so it's fast to
// adjust once the real decision comes in.
//
// Milestones fall into two groups:
//   - "system" — computed live from data this app already has (RT client
//     createdDate + bookings). Never stored here, so there's nothing that
//     can drift out of sync with RT itself.
//   - not "system" — no data source exists in this codebase to detect
//     these automatically (the client portal is a separate system with no
//     webhook/API into HeartBeat, and outbound email automation was
//     explicitly deferred: "the heartbeat is not yet built to send
//     outreach", confirmed 2026-08-22). These stay manual-entry-only
//     (logged as an ordinary centre_visits row with a matching
//     activity_type — see routes/centres.js) until that integration
//     exists; DECISIONS_REQUIRED below documents this as still open.

const MILESTONE_META = {
  centre_created:          { label: 'Centre created in RT',   icon: '🏢', system: true },
  first_booking_created:   { label: 'First booking created',  icon: '📅', system: true },
  first_booking_filled:    { label: 'First booking filled',   icon: '🧑‍🏫', system: true },
  first_booking_completed: { label: 'First booking completed', icon: '✅', system: true },
  second_booking_created:  { label: 'Second booking created', icon: '📅', system: true }
};

// "Which system is authoritative for each milestone?" (one of the Decision
// Area 5 "Decisions required" questions) — answered here as a starting
// default per milestone, not yet confirmed live:
const SYSTEM_OF_RECORD = {
  centre_created: 'RT (client.createdDate)',
  first_booking_created: 'RT (bookings)',
  first_booking_filled: 'RT (bookings.assignedUserId)',
  first_booking_completed: 'RT (bookings.statusId = 5)',
  second_booking_created: 'RT (bookings)',
  welcome_email_sent: 'Not yet automatable — no email-sending integration exists (deferred 2026-08-22)',
  first_portal_login: 'Not yet automatable — no client-portal integration exists in HeartBeat',
  centre_submitted: 'Workforce Partner admin app (manual entry)',
  centre_approved: 'Workforce Partner admin app (manual entry)'
};

function isRealAssignment(assignedUserId) {
  return assignedUserId != null && assignedUserId !== 0;
}

// bookingsForCentre: this one centre's RT bookings only (caller filters by
// locationId/clientId — see routes/centres.js's existing /activity route
// for the same filter it already does).
function computeSystemMilestones(centre, bookingsForCentre) {
  const milestones = [];
  if (centre?.createdDate) {
    milestones.push({ type: 'centre_created', date: centre.createdDate, detail: null });
  }

  const sorted = [...(bookingsForCentre || [])]
    .filter(b => b.bookingDate)
    .sort((a, b) => new Date(a.bookingDate) - new Date(b.bookingDate));

  if (sorted[0]) {
    milestones.push({ type: 'first_booking_created', date: sorted[0].bookingDate, detail: null });
  }
  const firstFilled = sorted.find(b => isRealAssignment(b.assignedUserId));
  if (firstFilled) {
    milestones.push({ type: 'first_booking_filled', date: firstFilled.bookingDate, detail: null });
  }
  // statusId 5 = Completed (see BOOKING_STATUS_LABELS in admin.html) —
  // deliberately not the broader MEANINGFUL_BOOKING_STATUSES {3,5} used
  // elsewhere for cadence, since "completed" here means the booking
  // actually happened, not just that it was filled.
  const firstCompleted = sorted.find(b => b.statusId === 5);
  if (firstCompleted) {
    milestones.push({ type: 'first_booking_completed', date: firstCompleted.bookingDate, detail: null });
  }
  if (sorted[1]) {
    milestones.push({ type: 'second_booking_created', date: sorted[1].bookingDate, detail: null });
  }

  return milestones.map(m => ({ ...m, ...MILESTONE_META[m.type], type: m.type }));
}

module.exports = { MILESTONE_META, SYSTEM_OF_RECORD, computeSystemMilestones };
