// Educator engagement / compliance / onboarding indicators (Sophia's
// "Micropod Proposal", 1st Draft; Joy 16 Oct). Read-only over HeartBeat's copy
// of RT: rt_candidates_cache for profiles and documents, and RT bookings
// (getCentresAndBookings, ~12 months of history) for completed shifts.
//
// Engagement — Active (RT status 1) educators only, checked top-down:
//   actively_working  3+ completed shifts in the past 7 days
//   actively_engaged  1+ completed shift in the past month
//   engaged           1+ completed shift in the past 3 months
//   disengaged        completed shifts before, none in the past 3 months
//   dormant           Active but no completed shift in the booking history
// Compliance — Active only: compliant / not_compliant (educatorComplianceService).
// Onboarding — RT status "In Progress": completion % from onBoardingStep (0–11).
const { getDb } = require('../db/database');
const { getCentresAndBookings } = require('../routes/centres');
const { complianceReasons } = require('./educatorComplianceService');
const { normalizeStateToShort } = require('./micropodService');

const DEFINITIONS = {
  actively_working: { label: 'Actively Working', group: 'engagement', desc: '3 or more shifts completed in the past 7 days.' },
  actively_engaged: { label: 'Actively Engaged', group: 'engagement', desc: 'At least 1 shift completed in the past month.' },
  engaged: { label: 'Engaged', group: 'engagement', desc: 'At least 1 shift completed in the past 3 months.' },
  disengaged: { label: 'Disengaged', group: 'engagement', desc: 'Has worked with us before, but no shift in the past 3 months.' },
  dormant: { label: 'Dormant', group: 'engagement', desc: 'No completed shift in the last 12 months (or never worked).' },
  compliant: { label: 'Active – Compliant', group: 'compliance', desc: 'Active, and every mandatory document is current and valid.' },
  not_compliant: { label: 'Active – Not Compliant', group: 'compliance', desc: 'Active, but one or more mandatory documents are missing, expired or invalid.' },
  ob_lt20: { label: 'In Progress <20%', group: 'onboarding', desc: 'Onboarding In Progress, under 20% complete.' },
  ob_20: { label: 'In Progress 20–39%', group: 'onboarding', desc: 'Onboarding In Progress, 20–39% complete.' },
  ob_40: { label: 'In Progress 40–59%', group: 'onboarding', desc: 'Onboarding In Progress, 40–59% complete.' },
  ob_60: { label: 'In Progress 60–79%', group: 'onboarding', desc: 'Onboarding In Progress, 60–79% complete.' },
  ob_80: { label: 'In Progress 80–99%', group: 'onboarding', desc: 'Onboarding In Progress, 80–99% complete.' },
  ob_100: { label: 'In Progress 100%', group: 'onboarding', desc: 'All onboarding steps done but RT status not yet Active.' }
};

// Shared with Micropods (routes/micropods.js): completed-shift dates per
// educator from HeartBeat's cached RT bookings, and Sophia's engagement label.
function completedShiftsByUser(bookings, now = Date.now()) {
  const shifts = new Map();
  for (const b of bookings) {
    if (b.statusId !== 5 || !b.assignedUserId || !b.bookingDate) continue;
    const t = new Date(b.bookingDate).getTime();
    if (t > now) continue;
    const k = String(b.assignedUserId);
    if (!shifts.has(k)) shifts.set(k, []);
    shifts.get(k).push(t);
  }
  return shifts;
}
function engagementTag(list, now = Date.now()) {
  const DAY = 864e5;
  const in7 = list.filter(t => now - t <= 7 * DAY).length, in30 = list.filter(t => now - t <= 30 * DAY).length, in90 = list.filter(t => now - t <= 91 * DAY).length;
  return in7 >= 3 ? 'actively_working' : in30 >= 1 ? 'actively_engaged' : in90 >= 1 ? 'engaged' : list.length ? 'disengaged' : 'dormant';
}

let cache = { at: 0, value: null };
async function computeIndicators() {
  if (cache.value && Date.now() - cache.at < 30 * 60 * 1000) return cache.value;
  const rows = (await getDb().execute({
    sql: `SELECT user_id::text uid, first_name, last_name, email, contact_no, suburb, status,
                 raw->'addresses' addrs, raw->'attachedRequirements' reqs, raw->'visaDetails' visa,
                 raw->'qualifications'->0->>'qualificationName' qual, (raw->>'onBoardingStep')::int ob_step, raw->>'obStatus' ob_status
          FROM rt_candidates_cache WHERE is_deleted IS NOT TRUE AND status IN (1, 4)`,
    args: []
  })).rows;
  const { bookings } = await getCentresAndBookings();
  const now = Date.now(), DAY = 864e5;
  const shifts = new Map();
  for (const b of bookings) {
    if (b.statusId !== 5 || !b.assignedUserId || !b.bookingDate) continue;
    const t = new Date(b.bookingDate).getTime();
    if (t > now) continue;
    const k = String(b.assignedUserId);
    if (!shifts.has(k)) shifts.set(k, []);
    shifts.get(k).push(t);
  }
  const today = new Date().toISOString().slice(0, 10);
  const people = rows.map(r => {
    const addrs = (r.addrs || []).filter(a => !a.isDeleted && a.isActive !== false);
    const a = addrs.find(x => x.addressTypeId === 1) || addrs[0] || {};
    const list = shifts.get(r.uid) || [];
    const last = list.length ? Math.max(...list) : null;
    const tags = [];
    if (r.status === 1) {
      const in7 = list.filter(t => now - t <= 7 * DAY).length, in30 = list.filter(t => now - t <= 30 * DAY).length, in90 = list.filter(t => now - t <= 91 * DAY).length;
      tags.push(in7 >= 3 ? 'actively_working' : in30 >= 1 ? 'actively_engaged' : in90 >= 1 ? 'engaged' : list.length ? 'disengaged' : 'dormant');
      tags.push(complianceReasons({ attachedRequirements: r.reqs, visaDetails: r.visa }, today).length ? 'not_compliant' : 'compliant');
    } else if (r.status === 4) {
      const pct = Math.round(Math.min(Math.max(r.ob_step || 0, 0), 11) / 11 * 100);
      tags.push(pct >= 100 ? 'ob_100' : pct >= 80 ? 'ob_80' : pct >= 60 ? 'ob_60' : pct >= 40 ? 'ob_40' : pct >= 20 ? 'ob_20' : 'ob_lt20');
    }
    const okCoord = Number.isFinite(a.latitude) && Number.isFinite(a.longitude) && !(a.latitude === 0 && a.longitude === 0);
    return {
      userId: r.uid, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), phone: r.contact_no, email: r.email,
      suburb: a.suburb || r.suburb || null, state: normalizeStateToShort(a.state) || null, qualification: r.qual,
      lastShift: last ? new Date(last).toISOString().slice(0, 10) : null, tags,
      lat: okCoord ? a.latitude : null, lng: okCoord ? a.longitude : null
    };
  });
  const value = { definitions: DEFINITIONS, people, computedAt: new Date().toISOString() };
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { computeIndicators, DEFINITIONS, completedShiftsByUser, engagementTag };
