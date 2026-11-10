// Onboarding beta (Phase 1 of "Faster Educator Onboarding in HeartBeat", 10 Nov 2026).
// super_admin only until Joy releases it. Read-only from RT (rt_candidates_cache) and
// JobAdder; our own notes live in onboarding_candidate_notes.
// Prioritised call list: candidates still onboarding, near a location, ranked by
// distance, discipline/qualification, recent activity, onboarding step and past shifts.
const { getDb } = require('../db/database');

const FOCUS_STATES = { victoria: 'VIC', 'south australia': 'SA', 'northern territory': 'NT', vic: 'VIC', sa: 'SA', nt: 'NT' };
const RT_STATUS_LABELS = { 0: 'Vetting Call', 1: 'Active', 2: 'In Progress', 4: 'Do Not Use', 5: 'Awaiting Activation', 8: 'Not Interested', 9: 'Student', 10: 'Pending Reference' };
// RT onboarding steps in order (obStatus); later = closer to done.
const OB_ORDER = ['Register', 'AboutUs', 'Qualification Level', 'Experience', 'Visa', 'Documents', 'Reference', 'Emergency Contact', 'Tax', 'Finance', 'Completed'];
const km = (a, b, c, d) => { const r = x => x * Math.PI / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const DAY = 864e5;

function qualOf(names) {
  const s = names.join(' | ').toLowerCase();
  return { level: /diploma|bachelor|degree|ect|teacher/.test(s) ? 'Diploma+' : /cert(ificate)?\s*iii|cert 3/.test(s) ? 'Cert III' : /working towards|studying|student/.test(s) ? 'Studying' : names.length ? 'Other' : 'None listed',
    oshc: /oshc|outside school/.test(s) };
}

// Location: a centreKey (uses its geocode) or a suburb name (centroid of RT addresses there).
async function resolveLocation({ centreKey, suburb }) {
  if (centreKey) {
    const centresMod = require('../routes/centres');
    const { centres } = await centresMod.getCentresAndBookings();
    const c = centres.find(x => x.centreKey === centreKey);
    if (!c) return null;
    const geo = (await require('./centreGeoService').getGeocodesForCentres([c]).catch(() => ({})))[c.centreKey];
    const lat = Number(geo?.lat ?? c.latitude), lng = Number(geo?.lng ?? c.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) && lat ? { label: c.name, lat, lng } : null;
  }
  if (suburb) {
    const r = (await getDb().execute({ sql: `SELECT avg((a->>'latitude')::float) lat, avg((a->>'longitude')::float) lng, count(*) n
        FROM rt_candidates_cache, jsonb_array_elements(raw->'addresses') a
        WHERE lower(a->>'suburb') = lower(?) AND (a->>'latitude') ~ '^-?[0-9.]+$' AND (a->>'latitude')::float <> 0`, args: [String(suburb).trim()] })).rows[0];
    return r && r.n > 0 ? { label: suburb, lat: Number(r.lat), lng: Number(r.lng) } : null;
  }
  return null;
}

async function pastShiftsByEducator() {
  try {
    const { bookings } = await require('../routes/centres').getCentresAndBookings();
    const out = {};
    for (const b of bookings) if ([2, 3, 5].includes(b.statusId) && b.assignedUserId) out[b.assignedUserId] = (out[b.assignedUserId] || 0) + 1;
    return out;
  } catch (_) { return {}; }
}

async function callList({ centreKey, suburb, radiusKm = 25, discipline = '', qual = '', limit = 100 }) {
  const loc = await resolveLocation({ centreKey, suburb });
  if (!loc) { const e = new Error('Could not find that location. Pick a centre, or type a suburb exactly.'); e.status = 400; throw e; }
  const rows = (await getDb().execute({ sql: `SELECT user_id::text uid, first_name, last_name, email, contact_no, status, raw->>'obStatus' ob,
        raw->'addresses'->0 addr, raw->'qualifications' quals, raw->'activities' acts, raw->>'createdDate' created, raw->>'statusUpdateDate' sud
      FROM rt_candidates_cache WHERE is_deleted IS NOT TRUE AND status NOT IN (4, 8)
        AND (coalesce(raw->>'obStatus','') <> 'Completed' OR status IN (0, 2, 5, 10))`, args: [] })).rows;
  const shifts = await pastShiftsByEducator();
  const now = Date.now();
  const out = [];
  for (const r of rows) {
    const st = FOCUS_STATES[String(r.addr?.state || '').trim().toLowerCase()];
    if (!st) continue;
    const lat = Number(r.addr?.latitude), lng = Number(r.addr?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat) continue;
    const dist = km(loc.lat, loc.lng, lat, lng);
    if (dist > radiusKm) continue;
    const q = qualOf((r.quals || []).filter(x => !x.isDeleted).map(x => x.qualificationName || '').filter(Boolean));
    if (qual && q.level !== qual) continue;
    if (discipline === 'oshc' && !q.oshc) continue;
    const dates = [...(r.acts || []).map(a => a.createdDate), r.sud, r.created].map(d => d && new Date(d).getTime()).filter(t => t && t > 946684800000);
    const lastActivity = dates.length ? Math.max(...dates) : null;
    const daysSince = lastActivity ? Math.floor((now - lastActivity) / DAY) : null;
    const stepIdx = Math.max(0, OB_ORDER.indexOf(r.ob));
    const past = shifts[r.uid] || shifts[Number(r.uid)] || 0;
    // Score (higher first): closer, further through onboarding, more recently active, has qualification, has worked for us.
    const score = Math.round((Math.max(0, 1 - dist / radiusKm) * 35) + (stepIdx / (OB_ORDER.length - 1)) * 25
      + (daysSince == null ? 0 : daysSince <= 7 ? 20 : daysSince <= 30 ? 14 : daysSince <= 90 ? 7 : 0)
      + (q.level === 'Diploma+' ? 10 : q.level === 'Cert III' ? 8 : q.level === 'Studying' ? 3 : 0) + Math.min(10, past * 2));
    out.push({ id: r.uid, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), email: r.email, phone: r.contact_no, state: st, suburb: r.addr?.suburb || '',
      distanceKm: Math.round(dist * 10) / 10, qualification: q.level, oshc: q.oshc, status: RT_STATUS_LABELS[r.status] || `Status ${r.status}`,
      onboardingStep: r.ob || '', lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null, daysSinceActivity: daysSince, pastShifts: past, score });
  }
  out.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
  return { location: loc, radiusKm, total: out.length, candidates: out.slice(0, limit) };
}

async function jobAdderMatch(email) {
  if (!email) return null;
  try {
    const token = await require('./jobAdderService').getValidAccessToken();
    if (!token) return { notConnected: true };
    const r = await fetch(`${token.apiBaseUrl}/candidates?email=${encodeURIComponent(email)}&limit=1`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!r.ok) return { error: `JobAdder ${r.status}` };
    const hit = ((await r.json()).items || [])[0];
    if (!hit) return null;
    const a = await fetch(`${token.apiBaseUrl}/candidates/${hit.candidateId}/attachments`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    const atts = a.ok ? ((await a.json()).items || []) : [];
    const resume = atts.find(x => /resume|cv/i.test(`${x.type || ''} ${x.fileName || ''}`)) || null;
    return { candidateId: hit.candidateId, name: `${hit.firstName || ''} ${hit.lastName || ''}`.trim(), status: hit.status?.name || '',
      resume: resume ? { attachmentId: resume.attachmentId, fileName: resume.fileName } : null };
  } catch (err) { return { error: err.message }; }
}

async function candidateDetail(id) {
  const r = (await getDb().execute({ sql: 'SELECT user_id::text uid, first_name, last_name, email, contact_no, status, raw FROM rt_candidates_cache WHERE user_id = ?', args: [id] })).rows[0];
  if (!r) return null;
  const raw = r.raw || {};
  const shifts = (await pastShiftsByEducator())[r.uid] || 0;
  const [notes, jobadder] = await Promise.all([
    getDb().execute({ sql: 'SELECT id, body, author_email, author_name, created_at FROM onboarding_candidate_notes WHERE candidate_id = ? ORDER BY created_at DESC', args: [String(id)] }).then(x => x.rows),
    jobAdderMatch(r.email)
  ]);
  return {
    id: r.uid, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), email: r.email, phone: r.contact_no,
    status: RT_STATUS_LABELS[r.status] || `Status ${r.status}`, onboardingStep: raw.obStatus || '', createdDate: raw.createdDate,
    address: [raw.addresses?.[0]?.suburb, raw.addresses?.[0]?.state, raw.addresses?.[0]?.postCode].filter(Boolean).join(', '),
    qualifications: (raw.qualifications || []).filter(q => !q.isDeleted).map(q => ({ name: q.qualificationName, college: q.collegeName, qualified: q.qualified })),
    experience: (raw.experience || []).slice(0, 10).map(e => ({ role: e.position || e.jobTitle || e.title || '', place: e.companyName || e.employer || '', from: e.fromDate || e.startDate || null, to: e.toDate || e.endDate || null })),
    documents: (raw.attachedRequirements || []).map(d => ({ name: d.requirementName || d.name || '', expiry: d.expiryDate || null })).filter(d => d.name).slice(0, 30),
    rtActivity: (raw.activities || []).slice().sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate)).slice(0, 15)
      .map(a => ({ at: a.createdDate, subject: a.subject || '', by: a.createdByName || '', text: String(a.text || '').replace(/<[^>]+>/g, ' ').slice(0, 300) })),
    pastShifts: shifts, notes, jobadder
  };
}

async function addNote(id, user, body) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) { const e = new Error('Note is empty'); e.status = 400; throw e; }
  return (await getDb().execute({ sql: 'INSERT INTO onboarding_candidate_notes (candidate_id, body, author_email, author_name) VALUES (?,?,?,?) RETURNING *',
    args: [String(id), text, user.email, user.name || user.email] })).rows[0];
}

module.exports = { callList, candidateDetail, addNote };
