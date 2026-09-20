// Automatic reactivation-based centre ownership (2026-09-21, Liam/Joy —
// see the WFP attribution model discussion). Principle: a centre that's
// gone dormant (no real booking in 6+ months — the one rule that's stayed
// consistent across every version of this model) and then gets a new
// booking is "reactivated", and whichever partner was actually engaging
// it (a logged call or visit) gets credit automatically. Confirmed
// directly against real booking data that RT's own booking records carry
// NO Workforce Partner identity at all — createdByName on a booking is
// always a centre contact or a RawTalent booking-ops consultant, never
// Liam/Justine/Gwen — so attribution has to come from HeartBeat's own
// centre_visits log, not from anything RT gives us. Joy was explicit this
// should be fully automatic, not a suggest-and-confirm step: last-touch
// (whoever logged the most recent call/visit inside the dormant gap)
// wins; if nobody logged anything in that gap, no credit is assigned and
// the centre stays RT's, same as origination's own "no signed lead, no
// claim" rule.
//
// Deliberately writes straight into centre_partner_assignments — the
// same table every other ownership read in this app (My Centres, the
// filter bar, Leads) already goes through — rather than a parallel table
// nobody reads. Never overwrites an existing row: a human's manual
// assignment (or an earlier origination/reactivation credit) always wins
// over a later automatic detection: this only ever fills a centre that
// currently has no owner at all.
const { getDb } = require('../db/database');
const { getCentresAndBookings, indexBookingsByCentre, bookingsForCentre } = require('../routes/centres');
const { MEANINGFUL_BOOKING_STATUSES } = require('./centreHealthService');

const REACTIVATION_GAP_DAYS = 180; // 6 months — the model's own consistent rule, deliberately separate from centreHealthService's 365-day dormancy (a different concept for a different purpose, see its own comment)
const SYSTEM_ASSIGNER_EMAIL = 'system@rawtalent.internal';
const SYSTEM_ASSIGNER_NAME = 'Auto — Reactivation';

// Real people, not territory labels — same three as WFP_ACTIVITY_PARTNERS
// in views/admin.html's Partner Activity card, kept in sync manually
// since one lives server-side and the other client-side (see that
// constant's own comment for why it's a real-people list, not a
// per-state one).
const REACTIVATION_CREDIT_PARTNERS = [
  { email: 'liam@rawtalent.com.au', label: 'Liam Baxter (VIC)' },
  { email: 'justine@rawtalent.com.au', label: 'Justine Hardware (VIC)' },
  { email: 'gwen@rawtalent.com.au', label: 'Gwen Stocks (SA)' }
];

function daysBetween(aIso, bIso) {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / (24 * 60 * 60 * 1000);
}

// For one centre's real (Assigned/Completed) booking dates, ascending —
// finds the most recent booking and, immediately before it, either the
// prior real booking or (if this is the only one visible in the fetch
// window) the start of that window itself. Either way, a gap of 6+ months
// there means the centre was genuinely dormant right up until this
// booking — we just don't always know exactly how much MORE dormant it
// was beyond the edge of what we fetched.
function findReactivation(bookingDates, windowStartIso) {
  if (!bookingDates.length) return null;
  const mostRecent = bookingDates[bookingDates.length - 1];
  const prior = bookingDates.length >= 2 ? bookingDates[bookingDates.length - 2] : windowStartIso;
  if (daysBetween(prior, mostRecent) < REACTIVATION_GAP_DAYS) return null;
  return { gapStart: prior, reactivatedAt: mostRecent };
}

// Reads every logged call/visit on this centre that falls inside the
// dormant gap, and credits whoever logged the LAST one before the
// reactivating booking — deliberately last-touch, not first-touch: the
// engagement immediately preceding the booking is the most defensible
// "this is what actually caused it" signal available.
async function creditedPartnerForGap(centreKey, gapStart, reactivatedAt) {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT created_by_email FROM centre_visits
          WHERE centre_key = ? AND visit_date > ? AND visit_date <= ?
            AND LOWER(created_by_email) IN (${REACTIVATION_CREDIT_PARTNERS.map(() => '?').join(',')})
          ORDER BY visit_date DESC LIMIT 1`,
    args: [centreKey, gapStart, reactivatedAt, ...REACTIVATION_CREDIT_PARTNERS.map(p => p.email)]
  });
  const row = result.rows[0];
  if (!row) return null;
  return REACTIVATION_CREDIT_PARTNERS.find(p => p.email === (row.created_by_email || '').toLowerCase()) || null;
}

async function detectAndCreditReactivations() {
  const { centres, bookings } = await getCentresAndBookings();
  const db = getDb();

  const existing = await db.execute('SELECT centre_key FROM centre_partner_assignments');
  const alreadyAssigned = new Set(existing.rows.map(r => r.centre_key));

  const windowStartIso = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
  const index = indexBookingsByCentre(bookings);

  let detected = 0, credited = 0;
  for (const centre of centres) {
    if (alreadyAssigned.has(centre.centreKey)) continue; // never overrides an existing owner — see this file's own header comment
    const dates = bookingsForCentre(index, centre)
      .filter(b => MEANINGFUL_BOOKING_STATUSES.has(b.statusId))
      .map(b => b.bookingDate)
      .filter(Boolean)
      .sort();
    const reactivation = findReactivation(dates, windowStartIso);
    if (!reactivation) continue;
    detected++;

    const partner = await creditedPartnerForGap(centre.centreKey, reactivation.gapStart, reactivation.reactivatedAt);
    if (!partner) continue; // no logged engagement in the gap — stays RT's, same as an un-signed lead

    await db.execute({
      sql: `INSERT INTO centre_partner_assignments (centre_key, workforce_partner, assigned_by_email, assigned_by_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (centre_key) DO NOTHING`,
      args: [centre.centreKey, partner.label, SYSTEM_ASSIGNER_EMAIL, SYSTEM_ASSIGNER_NAME]
    });
    alreadyAssigned.add(centre.centreKey); // so a later centre in this same run can't also claim it
    credited++;
  }
  return { detected, credited };
}

module.exports = { detectAndCreditReactivations, REACTIVATION_GAP_DAYS, REACTIVATION_CREDIT_PARTNERS };
