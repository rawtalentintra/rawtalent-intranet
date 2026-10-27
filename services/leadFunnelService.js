// Lead funnel stages (Liam, 26 Oct 2026), derived from fields that already
// exist rather than a parallel stage column:
//  new_wfp           New: Workforce Partners only, until a WFP has called or visited it
//                    (lead_called_status / centre_visited_status = 'done')
//  contacted_wfp     Contacted by WFP, pre-booking ("revisit in a couple of months")
//  consultant        In consultant nurture: a consultant has washed it as SOLID or
//                    logged a consultant call after the WFP contact
//  set_up            Set up as a centre: signed, or matched to an RT centre
//  first_booking     The matched RT centre has a booking since the lead was created
//  repeat            Two or more bookings since then
// Archived or closed leads sit outside the funnel ("archived").
// HeartBeat holds ~12 months of RT bookings; if RT is unavailable, set_up /
// first_booking / repeat can't be worked out and those leads stay at their
// HeartBeat-only stage (rtAvailable=false in the result).
const { getDb } = require('../db/database');

const STAGES = [
  ['new_wfp', 'New (WFP only)'], ['contacted_wfp', 'Contacted by WFP'], ['consultant', 'In consultant nurture'],
  ['set_up', 'Set up as centre'], ['first_booking', 'First booking'], ['repeat', 'Repeat bookings']
];
let cache = { at: 0, value: null };

async function computeStages({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;
  const db = getDb();
  const leads = (await db.execute({
    sql: `SELECT id, centre_name, centre_phone, contact_email, suburb, state, created_at, lead_called_status, lead_called_at,
                 centre_visited_status, centre_visited_at, signed_status, archived_at, closed_at, service_type, group_category
          FROM leads`, args: []
  })).rows;
  const washes = (await db.execute({
    sql: `SELECT DISTINCT ON (lead_id) lead_id, verdict, washed_at FROM lead_washes ORDER BY lead_id, washed_at DESC`, args: []
  }).catch(() => ({ rows: [] }))).rows;
  const consultantCalls = (await db.execute({
    sql: `SELECT lead_id, max(called_at) at FROM consultant_calls WHERE lead_id IS NOT NULL GROUP BY 1`, args: []
  }).catch(() => ({ rows: [] }))).rows;
  const washBy = new Map(washes.map(w => [w.lead_id, w]));
  const callBy = new Map(consultantCalls.map(c => [c.lead_id, c.at]));

  let rawClients = [], bookingsByKey = new Map(), rtAvailable = true;
  try {
    const { getCentresAndBookings } = require('../routes/centres');
    const cb = await getCentresAndBookings();
    rawClients = cb.rawClients;
    for (const b of cb.bookings) {
      if (![1, 2, 3, 5].includes(b.statusId) || !b.bookingDate) continue;
      const t = new Date(b.bookingDate).getTime(); if (t > Date.now()) continue;
      for (const k of [`loc:${b.locationId}`, `client:${b.clientId}`]) { if (!bookingsByKey.has(k)) bookingsByKey.set(k, []); bookingsByKey.get(k).push(t); }
    }
  } catch { rtAvailable = false; }
  const match = require('./centreMatchService');

  const byLead = {}, counts = Object.fromEntries([...STAGES.map(s => [s[0], 0]), ['archived', 0]]);
  for (const l of leads) {
    let stage, centreKey = null;
    if (l.archived_at || l.closed_at) stage = 'archived';
    else {
      const wfpContacted = l.lead_called_status === 'done' || l.centre_visited_status === 'done';
      stage = wfpContacted ? 'contacted_wfp' : 'new_wfp';
      const w = washBy.get(l.id), call = callBy.get(l.id);
      if (w?.verdict === 'solid' || call) stage = 'consultant';
      const m = rtAvailable ? match.findConfidentMatch(l, rawClients) : null;
      if (m) centreKey = m.rtLocationId ? `loc:${m.rtLocationId}` : `client:${m.rtClientId}`;
      if (l.signed_status === 'signed' || centreKey) stage = 'set_up';
      if (centreKey) {
        const n = (bookingsByKey.get(centreKey) || []).filter(t => t >= new Date(l.created_at).getTime()).length;
        if (n >= 2) stage = 'repeat'; else if (n === 1) stage = 'first_booking';
      }
    }
    byLead[l.id] = { stage, centreKey };
    counts[stage]++;
  }
  const value = { stages: STAGES.map(([key, label]) => ({ key, label, count: counts[key] })), archived: counts.archived, byLead, rtAvailable, computedAt: new Date().toISOString() };
  cache = { at: Date.now(), value };
  return value;
}
function invalidate() { cache = { at: 0, value: null }; }

module.exports = { STAGES, computeStages, invalidate };
