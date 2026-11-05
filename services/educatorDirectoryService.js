// One accurate view of every RT educator for the MCP tools (Liam's AI), matching
// RT Portal's Candidates screen: RT Portal's status names (from the status number,
// never RT's statusName text, which is wrong for most statuses), onboarding step,
// Compliant / Not Compliant (services/educatorComplianceService.js, which follows
// RT Portal where our document check disagreed), state, gender and qualification,
// plus HeartBeat's engagement group and shift history from RT bookings.
// Read-only. Rebuilt at most every 30 minutes; the RT copy itself refreshes every
// 2 hours 8am-8pm Melbourne and overnight.
const { getDb } = require('../db/database');
const { complianceReasons } = require('./educatorComplianceService');

const RT_STATUS_LABELS = { 0: 'Vetting Call', 1: 'Active', 2: 'In Progress', 4: 'Do Not Use', 5: 'Awaiting Activation', 8: 'Not Interested', 9: 'Student', 10: 'Pending Reference' };
const REGION_TO_STATE = { 1: 'NSW', 2: 'QLD', 3: 'TAS', 4: 'VIC', 5: 'SA', 6: 'WA', 7: 'NT', 8: 'ACT' };
const GENDER = { 0: 'Not stated', 1: 'Male', 2: 'Female', 3: 'Other' };
const ENGAGEMENT_LABELS = { actively_working: 'Actively Working', actively_engaged: 'Actively Engaged', engaged: 'Engaged', disengaged: 'Disengaged', dormant: 'Dormant' };
const ENGAGEMENT_DEFS = {
  'Actively Working': '3 or more shifts completed in the past 7 days',
  'Actively Engaged': 'at least 1 shift completed in the past month',
  'Engaged': 'at least 1 shift completed in the past 3 months',
  'Disengaged': 'has worked with us before, but no shift in the past 3 months',
  'Dormant': 'no completed shift in the last 12 months (or never worked)'
};
const TTL_MS = 30 * 60 * 1000;
let cache = { list: null, byId: null, builtAt: 0 };

async function getDirectory() {
  if (cache.list && Date.now() - cache.builtAt < TTL_MS) return cache;
  const rows = (await getDb().execute({
    sql: `SELECT user_id, first_name, last_name, email, contact_no, suburb, status, created_date, synced_at,
            raw->>'obStatus' AS ob_status, raw->>'gender' AS gender,
            (raw->'addresses'->0->>'regionId')::int AS region,
            (raw->'addresses'->0->>'latitude')::float8 AS lat,
            (raw->'addresses'->0->>'longitude')::float8 AS lng,
            raw->'qualifications'->0->>'qualificationName' AS qualification,
            raw->'attachedRequirements' AS reqs, raw->'visaDetails' AS visa
          FROM rt_candidates_cache WHERE is_deleted IS NOT TRUE`,
    args: []
  })).rows;
  const { completedShiftsByUser, engagementTag } = require('./educatorIndicatorsService');
  const { bookings } = await require('../routes/centres').getCentresAndBookings();
  const shiftsByUser = completedShiftsByUser(bookings);
  const today = new Date().toISOString().slice(0, 10);
  const list = rows.map(r => {
    const shifts = shiftsByUser.get(String(r.user_id)) || [];
    const last = shifts.length ? Math.max(...shifts) : null;
    const reasons = complianceReasons({ attachedRequirements: r.reqs, visaDetails: r.visa }, today, r.user_id);
    const geo = Number.isFinite(r.lat) && Number.isFinite(r.lng) && !(r.lat === 0 && r.lng === 0);
    return {
      id: String(r.user_id),
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || `Candidate #${r.user_id}`,
      phone: r.contact_no || null, email: r.email || null, suburb: r.suburb || null,
      state: REGION_TO_STATE[r.region] || null,
      status: RT_STATUS_LABELS[r.status] || `Status ${r.status}`,
      onboarding: r.ob_status === 'Completed' ? 'Complete' : (r.ob_status || 'Not started'),
      compliant: reasons.length === 0,
      complianceIssues: reasons,
      gender: GENDER[r.gender] || 'Not stated',
      qualification: r.qualification || null,
      engagement: ENGAGEMENT_LABELS[engagementTag(shifts)] || 'Dormant',
      shiftsLast28Days: shifts.filter(t => Date.now() - t <= 28 * 864e5).length,
      shiftsLast12Months: shifts.filter(t => Date.now() - t <= 365 * 864e5).length,
      lastShift: last ? new Date(last).toISOString().slice(0, 10) : null,
      joined: r.created_date ? String(r.created_date).slice(0, 10) : null,
      lat: geo ? r.lat : null, lng: geo ? r.lng : null,
      lastSyncedFromRt: r.synced_at ? new Date(r.synced_at).toISOString() : null
    };
  });
  cache = { list, byId: new Map(list.map(e => [e.id, e])), builtAt: Date.now() };
  return cache;
}

module.exports = { getDirectory, RT_STATUS_LABELS, ENGAGEMENT_DEFS };
