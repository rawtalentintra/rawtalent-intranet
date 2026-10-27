// "Available educators" emails (Liam, 26 Oct 2026). Event contract agreed with
// RT - Customer.io (handbook §18):
//   available_educators_favourites → automation #40: existing RT centres.
//     "Here are your favourites, book them before someone else does."
//   available_educators_nearby → automation #41: leads + RT centres with no
//     bookings yet. "Educators centres in your area love."
// Same transport as First Booking Free (profile identified by RT person id,
// never created by email). OFF unless FBF_CIO_ENABLED=true AND
// AVAILABLE_EDUCATORS_CIO_ENABLED=true; the weekly Thursday 9am run also needs
// AVAILABLE_EDUCATORS_WEEKLY=true. HeartBeat enforces: one email per centre per
// 7 days across both events; skip if FBF was offered or a dormant touch point
// was completed in the last 7 days; never send an empty list (1–4 educators).
// Client-facing fields only: first name + last initial, qualification, shifts,
// availability. Photos stay blank until Joy approves. Read-only from RT.
const { getDb } = require('../db/database');
const fbf = require('./firstBookingFreeService');
const { complianceReasons } = require('./educatorComplianceService');

const on = v => String(process.env[v] || '').toLowerCase() === 'true';
const switches = () => ({ cio: on('FBF_CIO_ENABLED'), available: on('AVAILABLE_EDUCATORS_CIO_ENABLED'), weekly: on('AVAILABLE_EDUCATORS_WEEKLY') });
const DAY = 864e5;
const km = (a, b, c, d) => { const r = x => x * Math.PI / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const shortState = s => ({ victoria: 'VIC', 'south australia': 'SA', queensland: 'QLD', 'new south wales': 'NSW', 'australian capital territory': 'ACT', 'northern territory': 'NT' })[String(s || '').trim().toLowerCase()] || String(s || '').trim().toUpperCase() || '';
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function activeEducators() {
  const rows = (await getDb().execute({
    sql: `SELECT user_id::text uid, first_name, last_name, raw->'addresses'->0 addr, raw->'qualifications'->0->>'qualificationName' qual,
                 raw->'availableCandidateList' avail, raw->'attachedRequirements' reqs, raw->'visaDetails' visa
          FROM rt_candidates_cache WHERE is_deleted IS NOT TRUE AND status = 1 AND raw->>'obStatus' = 'Completed'`, args: []
  })).rows;
  const today = new Date().toISOString().slice(0, 10), now = Date.now();
  return rows.filter(r => !complianceReasons({ attachedRequirements: r.reqs, visaDetails: r.visa }, today).length).map(r => {
    const days = [...new Set((r.avail || []).filter(a => { const t = new Date(a.date).getTime(); return t >= now - DAY && t <= now + 7 * DAY; }).map(a => new Date(a.date).getDay()))].sort();
    return {
      id: r.uid, firstName: r.first_name || '', fullName: `${r.first_name || ''}${r.last_name ? ' ' + r.last_name.trim()[0] + '.' : ''}`.trim(),
      qualification: r.qual || '', lat: Number(r.addr?.latitude), lng: Number(r.addr?.longitude), availability: days.map(d => WEEKDAY[d]).join(', ')
    };
  });
}

// Resolve a target: { centreKey } or { leadId }.
async function resolveTarget({ centreKey, leadId }) {
  const centresMod = require('../routes/centres');
  const { centres, bookings } = await centresMod.getCentresAndBookings();
  if (centreKey) {
    const c = centres.find(x => x.centreKey === centreKey);
    if (!c) return null;
    const geo = (await require('./centreGeoService').getCachedGeocodesOnly([c]).catch(() => ({})))[c.centreKey];
    const mine = centresMod.bookingsForCentre(centresMod.indexBookingsByCentre(bookings), c).filter(b => [1, 2, 3, 5].includes(b.statusId));
    return { key: centreKey, kind: 'centre', name: c.name, state: shortState(c.state), lat: geo?.lat ?? c.latitude, lng: geo?.lng ?? c.longitude, bookings: mine, centre: c };
  }
  const l = (await getDb().execute({ sql: 'SELECT id, centre_name, state, latitude, longitude, contact_first_name, assigned_workforce_partner FROM leads WHERE id = ?', args: [leadId] })).rows[0];
  if (!l) return null;
  return { key: `lead:${l.id}`, kind: 'lead', leadId: l.id, name: l.centre_name, state: shortState(l.state), lat: l.latitude, lng: l.longitude, bookings: [], lead: l };
}

async function pickEducators(t, max = 4) {
  const eds = await activeEducators();
  const byId = new Map(eds.map(e => [e.id, e]));
  const shiftsBy = {};
  const { bookings } = await require('../routes/centres').getCentresAndBookings();
  for (const b of bookings) if (b.statusId === 5 && b.assignedUserId) shiftsBy[b.assignedUserId] = (shiftsBy[b.assignedUserId] || 0) + 1;
  const withShifts = e => ({ ...e, shiftsCompleted: shiftsBy[e.id] || 0 });
  if (t.kind === 'centre' && t.bookings.length) {
    // Favourites: tagged favourite in HeartBeat, requested by name on bookings, then most shifts here.
    const fav = (await getDb().execute({ sql: "SELECT candidate_user_id FROM centre_educator_relationships WHERE centre_key = ? AND relationship_type = 'favourite'", args: [t.key] })).rows.map(r => String(r.candidate_user_id));
    const score = {};
    fav.forEach(id => { score[id] = (score[id] || 0) + 1000; });
    t.bookings.forEach(b => {
      if (b.requestedCandidateId) score[b.requestedCandidateId] = (score[b.requestedCandidateId] || 0) + 50;
      if (b.statusId === 5 && b.assignedUserId) score[b.assignedUserId] = (score[b.assignedUserId] || 0) + 1;
    });
    const list = Object.entries(score).filter(([id, sc]) => byId.has(String(id)) && sc >= 3).sort((a, b) => b[1] - a[1]).slice(0, max).map(([id]) => withShifts(byId.get(String(id))));
    return { event: 'available_educators_favourites', educators: list };
  }
  if (!Number.isFinite(Number(t.lat)) || !Number.isFinite(Number(t.lng))) return { event: 'available_educators_nearby', educators: [], note: 'No map location for this centre' };
  const near = eds.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lng) && !(e.lat === 0 && e.lng === 0))
    .map(e => ({ ...withShifts(e), km: km(Number(t.lat), Number(t.lng), e.lat, e.lng) })).filter(e => e.km <= 15)
    .sort((a, b) => (b.availability ? 1 : 0) - (a.availability ? 1 : 0) || b.shiftsCompleted - a.shiftsCompleted || a.km - b.km).slice(0, max);
  return { event: 'available_educators_nearby', educators: near };
}

async function blockers(t) {
  const db = getDb();
  const recent = (await db.execute({ sql: "SELECT 1 FROM available_educator_sends WHERE target_key = ? AND status = 'sent' AND created_at > now() - interval '7 days'", args: [t.key] })).rows.length;
  if (recent) return 'An available-educators email already went to this centre in the last 7 days';
  const fbfRecent = (await db.execute({ sql: `SELECT 1 FROM first_booking_free_offers WHERE offered_at > now() - interval '7 days' AND (${t.kind === 'centre' ? 'centre_key = ?' : 'lead_id = ?'})`, args: [t.kind === 'centre' ? t.key : t.leadId] })).rows.length;
  if (fbfRecent) return 'First booking free was offered in the last 7 days (that journey is running)';
  if (t.kind === 'centre') {
    const dormant = (await db.execute({ sql: "SELECT 1 FROM dormant_touchpoints WHERE centre_key = ? AND completed_at > now() - interval '7 days'", args: [t.key] }).catch(() => ({ rows: [] }))).rows.length;
    if (dormant) return 'A dormant touch point was completed in the last 7 days (that journey is running)';
  }
  return null;
}

async function log(t, event, educators, status, detail, source, by) {
  await getDb().execute({ sql: 'INSERT INTO available_educator_sends (target_key, event_name, educator_ids, status, detail, source, requested_by) VALUES (?,?,?,?,?,?,?)',
    args: [t.key, event, JSON.stringify(educators.map(e => e.id)), status, detail || null, source, by || null] });
}

// Preview (no send): what would go, and whether anything blocks it.
async function preview(target) {
  const t = await resolveTarget(target);
  if (!t) return null;
  const pick = await pickEducators(t);
  const blocked = await blockers(t);
  const sw = switches();
  return { target: { key: t.key, kind: t.kind, name: t.name, state: t.state }, event: pick.event, educators: pick.educators.map(e => ({ fullName: e.fullName, qualification: e.qualification, shiftsCompleted: e.shiftsCompleted, availability: e.availability, km: e.km != null ? Math.round(e.km * 10) / 10 : undefined })),
    blockedReason: blocked || (pick.educators.length ? null : (pick.note || 'No matching educators right now')), switchedOn: sw.cio && sw.available };
}

async function send(target, { source = 'button', user = null } = {}) {
  const t = await resolveTarget(target);
  if (!t) throw Object.assign(new Error('Not found'), { status: 404 });
  const pick = await pickEducators(t);
  const blocked = await blockers(t);
  const by = user?.email || 'schedule';
  if (blocked) { await log(t, pick.event, pick.educators, 'skipped', blocked, source, by); return { status: 'skipped', reason: blocked }; }
  if (!pick.educators.length) { await log(t, pick.event, [], 'skipped', 'No educators to show', source, by); return { status: 'skipped', reason: 'No educators to show' }; }
  const sw = switches();
  if (!(sw.cio && sw.available)) { await log(t, pick.event, pick.educators, 'off', 'Emails are switched off', source, by); return { status: 'off', reason: 'Available-educator emails are switched off. Nothing was sent.' }; }
  // Identity: RT person id only (leads without an RT profile are skipped until Joy approves lead profiles).
  let ident = null, firstName = '';
  if (t.kind === 'centre') {
    const ct = await fbf.resolveContact({ centreKey: t.key }); ident = ct?.rtPersonId ? String(ct.rtPersonId) : null; firstName = ct?.firstName || '';
  } else {
    const ct = await fbf.resolveContact({ leadId: t.leadId }); ident = ct?.rtPersonId ? String(ct.rtPersonId) : null; firstName = ct?.firstName || t.lead?.contact_first_name || '';
  }
  if (!ident) { await log(t, pick.event, pick.educators, 'skipped', 'No RT/Customer.io profile', source, by); return { status: 'skipped', reason: 'This centre has no RT/Customer.io profile yet' }; }
  const data = {
    centre_key: t.key, centre_name: t.name, contact_first_name: firstName, state: t.state,
    partner_name: t.lead?.assigned_workforce_partner || '',
    educators: pick.educators.map(e => ({ educator_id: e.id, first_name: e.firstName, full_name: e.fullName, photo_url: '', qualification: e.qualification, shifts_completed: e.shiftsCompleted, availability: e.availability }))
  };
  try {
    await fbf.sendCioSignal(ident, {}, pick.event, data);
    await log(t, pick.event, pick.educators, 'sent', null, source, by);
    return { status: 'sent', event: pick.event, educators: pick.educators.length };
  } catch (err) { await log(t, pick.event, pick.educators, 'failed', err.message, source, by); throw err; }
}

// Thursday 9am Melbourne weekly run (needs AVAILABLE_EDUCATORS_WEEKLY=true).
async function runWeekly(now = new Date()) {
  const sw = switches();
  if (!(sw.cio && sw.available && sw.weekly)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now).map(x => [x.type, x.value]));
  if (p.weekday !== 'Thu' || Number(p.hour) !== 9) return null;
  const done = (await getDb().execute({ sql: "SELECT 1 FROM available_educator_sends WHERE source = 'weekly' AND created_at > now() - interval '20 hours'", args: [] })).rows.length;
  if (done) return null;
  const due = await require('./consultantCallService').dueList({ includeAll: true });
  const results = { sent: 0, skipped: 0 };
  for (const item of due.items) {
    try { const r = await send(item.kind === 'centre' ? { centreKey: item.key } : { leadId: item.leadId }, { source: 'weekly' }); results[r.status === 'sent' ? 'sent' : 'skipped']++; } catch { results.skipped++; }
  }
  return results;
}

module.exports = { preview, send, runWeekly, switches };
