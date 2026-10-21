// Centre History tab (Liam, 19 Oct 2026 strategy meeting): one chronological
// story per centre, e.g. "Journey 1 → first booking after the 3rd email →
// positive → went dormant → call (what was said) → Dormant sequence with FBF →
// booked after 3 emails → now 3 bookings/week".
// Sources: RT bookings (HeartBeat's ~12-month copy), regular educators,
// centre calls/visits and notes, centre voice notes (summary + transcript),
// the linked lead's history (notes, calls/visits, stage changes, voice notes),
// First Booking Free offers, dormant touch points, and Customer.io emails
// (read-only App API; "not connected" until CUSTOMERIO_APP_API_KEY is set).
// Reads only; never writes to RT or Customer.io.
const { getDb } = require('../db/database');

const LIVE = new Set([1, 2, 3, 5]);
const FILLED = new Set([3, 5]);
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
const monthKey = d => String(d).slice(0, 7);

const campaignNames = new Map();
async function cioMessages(ident) {
  const key = process.env.CUSTOMERIO_APP_API_KEY;
  if (!key) return { connected: false, messages: [] };
  if (!ident) return { connected: true, messages: [], note: 'No Customer.io profile found for this centre yet.' };
  const h = { Authorization: `Bearer ${key}` };
  const r = await fetch(`https://api.customer.io/v1/customers/${encodeURIComponent(ident)}/messages?limit=100`, { headers: h });
  if (r.status === 404) return { connected: true, messages: [], note: 'No Customer.io profile found for this centre yet.' };
  if (!r.ok) return { connected: true, messages: [], note: `Customer.io returned ${r.status}.` };
  const d = await r.json();
  const list = d.messages || [];
  for (const m of list) {
    if (m.campaign_id && !campaignNames.has(m.campaign_id)) {
      try {
        const c = await fetch(`https://api.customer.io/v1/campaigns/${m.campaign_id}`, { headers: h }).then(x => x.ok ? x.json() : null);
        campaignNames.set(m.campaign_id, c?.campaign?.name || `Journey ${m.campaign_id}`);
      } catch { campaignNames.set(m.campaign_id, `Journey ${m.campaign_id}`); }
    }
  }
  return {
    connected: true,
    messages: list.filter(m => m.type === 'email' || !m.type).map(m => ({
      at: m.created ? new Date(m.created * 1000).toISOString() : null,
      journey: m.campaign_id ? campaignNames.get(m.campaign_id) : (m.broadcast_id ? 'Broadcast' : m.newsletter_id ? 'Newsletter' : 'Transactional'),
      subject: m.subject || m.name || '',
      opened: !!(m.metrics && m.metrics.opened), clicked: !!(m.metrics && m.metrics.clicked)
    }))
  };
}

async function buildCentreHistory(centreKey, { noTranscripts = false } = {}) {
  const db = getDb();
  const { getCentresAndBookings } = require('../routes/centres');
  const { centres, bookings, rawClients } = await getCentresAndBookings();
  const c = centres.find(x => x.centreKey === centreKey);
  if (!c) return null;
  const [kind, idStr] = centreKey.split(':');
  const mine = bookings.filter(b => kind === 'loc' ? String(b.locationId) === idStr : String(b.clientId) === idStr);
  const live = mine.filter(b => LIVE.has(b.statusId) && b.bookingDate).sort((a, b) => new Date(a.bookingDate) - new Date(b.bookingDate));
  const past = live.filter(b => new Date(b.bookingDate) <= new Date());

  // Bookings per month (shift dates), last 12 months
  const perMonth = {};
  for (const b of mine) {
    if (!b.bookingDate) continue;
    const k = monthKey(b.bookingDate);
    perMonth[k] = perMonth[k] || { month: k, booked: 0, filled: 0, cancelled: 0 };
    if (LIVE.has(b.statusId)) perMonth[k].booked++;
    if (FILLED.has(b.statusId)) perMonth[k].filled++;
    if (b.statusId === 6 || b.statusId === 7) perMonth[k].cancelled++;
  }
  const last4w = past.filter(b => Date.now() - new Date(b.bookingDate) <= 28 * 864e5).length;

  // Regular / favourite educators
  const eds = {};
  for (const b of mine) {
    // Shifts already worked (up to today); booked-ahead shifts aren't counted here.
    if (!FILLED.has(b.statusId) || !b.assignedUserId || !b.bookingDate || new Date(b.bookingDate) > new Date()) continue;
    const k = String(b.assignedUserId);
    eds[k] = eds[k] || { userId: k, name: b.assignedCandidateName || `Educator ${k}`, shifts: 0, favourite: false, last: null };
    eds[k].shifts++;
    if (b.isFavouriteBooking || (b.requestedCandidateId && String(b.requestedCandidateId) === k)) eds[k].favourite = true;
    if (!eds[k].last || b.bookingDate > eds[k].last) eds[k].last = b.bookingDate;
  }
  const educators = Object.values(eds).sort((a, b) => b.shifts - a.shifts).slice(0, 10).map(e => ({ ...e, last: day(e.last) }));

  // Linked lead(s): HeartBeat doesn't store a lead→centre link, so match the
  // same way as the Leads page's "Existing Centre?" column (centreMatchService),
  // checking only leads in the same suburb.
  const centreMatch = require('./centreMatchService');
  const sameSuburb = (await db.execute({
    sql: `SELECT id, centre_name, centre_phone, contact_email, suburb, state, created_at, submitted_by_name, lead_called_status, lead_called_at, centre_visited_status, centre_visited_at, signed_status, signed_at
          FROM leads WHERE lower(trim(suburb)) = lower(trim(?))`, args: [c.suburb || '']
  }).catch(() => ({ rows: [] }))).rows;
  const leads = sameSuburb.filter(l => {
    const m = centreMatch.findConfidentMatch(l, rawClients);
    return m && (m.rtLocationId ? `loc:${m.rtLocationId}` : `client:${m.rtClientId}`) === centreKey;
  });
  const leadIds = leads.map(l => l.id);

  const q = (sql, args) => db.execute({ sql, args }).then(r => r.rows).catch(() => []);
  const [visits, recs, tps, offers, lNotes, lActs, lRecs] = await Promise.all([
    q('SELECT * FROM centre_visits WHERE centre_key = ? ORDER BY visit_date', [centreKey]),
    q('SELECT id, created_at, detected_at, uploaded_by_name, summary, transcript FROM centre_recordings WHERE centre_key = ? ORDER BY created_at', [centreKey]),
    q('SELECT * FROM dormant_touchpoints WHERE centre_key = ? ORDER BY completed_at', [centreKey]),
    q(`SELECT * FROM first_booking_free_offers WHERE centre_key = ? ${leadIds.length ? 'OR lead_id = ANY(?)' : ''}`, leadIds.length ? [centreKey, leadIds] : [centreKey]),
    leadIds.length ? q('SELECT lead_id, note, author_name, created_at FROM lead_notes WHERE lead_id = ANY(?)', [leadIds]) : [],
    leadIds.length ? q('SELECT lead_id, channel, contact_name, outcome, notes, created_by_name, created_at FROM lead_activities WHERE lead_id = ANY(?)', [leadIds]) : [],
    leadIds.length ? q('SELECT lead_id, created_at, uploaded_by_name, summary, transcript FROM lead_recordings WHERE lead_id = ANY(?)', [leadIds]) : []
  ]);

  const ev = [];
  const push = (at, type, title, detail, by) => at && ev.push({ at: new Date(at).toISOString(), type, title, detail: detail || '', by: by || '' });
  for (const l of leads) {
    push(l.created_at, 'lead', 'Lead created', l.centre_name, l.submitted_by_name);
    if (l.lead_called_status === 'done') push(l.lead_called_at, 'stage', 'Lead called', '', '');
    if (l.centre_visited_status === 'done') push(l.centre_visited_at, 'stage', 'Lead visited', '', '');
    if (l.signed_status === 'signed') push(l.signed_at, 'stage', 'Signed up', '', '');
  }
  lNotes.forEach(n => push(n.created_at, 'note', 'Note', n.note, n.author_name));
  lActs.forEach(a => push(a.created_at, a.channel === 'visit' ? 'visit' : 'call', a.channel === 'visit' ? 'Visit (lead)' : 'Call (lead)', [a.contact_name && `Spoke with ${a.contact_name}`, a.outcome && `Outcome: ${a.outcome}`, a.notes].filter(Boolean).join(' · '), a.created_by_name));
  lRecs.forEach(r => push(r.created_at, 'voice', 'Voice note', r.summary || (!noTranscripts && r.transcript ? r.transcript.slice(0, 400) : ''), r.uploaded_by_name));
  visits.filter(v => v.status === 'completed').forEach(v => push(v.visit_date, v.channel === 'call' ? 'call' : 'visit', v.channel === 'call' ? 'Call' : 'Visit', [v.contact_name && `Spoke with ${v.contact_name}`, v.outcome && `Outcome: ${v.outcome}`, v.notes, v.next_step && `Next: ${v.next_step}`].filter(Boolean).join(' · '), v.created_by_name));
  recs.forEach(r => push(r.detected_at || r.created_at, 'voice', 'Voice note', r.summary || (!noTranscripts && r.transcript ? r.transcript.slice(0, 400) : ''), r.uploaded_by_name));
  offers.forEach(o => push(o.offered_at, 'fbf', 'First booking free offered', o.email_status === 'via_dormant' ? 'Offered during a dormant touch point' : '', o.offered_by_name));
  offers.filter(o => o.booking_id).forEach(o => push(o.booking_date, 'fbf', 'Free first booking used', `RT booking ${o.booking_id}`, ''));
  tps.forEach(t => push(t.completed_at, 'dormant', 'Dormant touch point complete', [`By ${t.touchpoint_type}`, t.first_booking_free && 'First booking free offered', t.pricing_note && `Pricing: ${t.pricing_note}`, t.discount_per_hour != null && `Discount $${Number(t.discount_per_hour).toFixed(2)}/hr${t.approval_task_id ? ' (sent to Liam to approve)' : ''}`].filter(Boolean).join(' · '), t.completed_by_name));
  if (past.length) push(past[0].bookingDate, 'booking', 'First booking (in HeartBeat\'s 12-month history)', `${past[0].assignedCandidateName || ''}`.trim(), '');
  // Dormancy gaps: 6+ months between bookings, or since the last one
  for (let i = 1; i < past.length; i++) {
    const gap = (new Date(past[i].bookingDate) - new Date(past[i - 1].bookingDate)) / 864e5;
    if (gap >= 182) { push(new Date(new Date(past[i - 1].bookingDate).getTime() + 182 * 864e5), 'dormant', 'Went dormant', `No booking for 6 months after ${day(past[i - 1].bookingDate)}`, ''); push(past[i].bookingDate, 'booking', 'Booked again', `After ${Math.round(gap)} days`, ''); }
  }
  const lastPast = past[past.length - 1];
  if (lastPast && (Date.now() - new Date(lastPast.bookingDate)) / 864e5 >= 182) push(new Date(new Date(lastPast.bookingDate).getTime() + 182 * 864e5), 'dormant', 'Went dormant', `No booking since ${day(lastPast.bookingDate)}`, '');

  // Customer.io emails (read-only)
  let emails = { connected: false, messages: [] };
  try {
    const fbf = require('./firstBookingFreeService');
    const ct = await fbf.resolveContact({ centreKey });
    const ident = ct && ct.rtPersonId ? String(ct.rtPersonId) : null;
    emails = await cioMessages(ident);
    emails.messages.forEach(m => push(m.at, 'email', `Email: ${m.journey}`, [m.subject, m.opened && 'opened', m.clicked && 'clicked'].filter(Boolean).join(' · '), ''));
  } catch (err) { emails = { connected: !!process.env.CUSTOMERIO_APP_API_KEY, messages: [], note: err.message }; }

  ev.sort((a, b) => a.at.localeCompare(b.at));
  const client = rawClients.find(x => String(x.clientId) === String(c.rtClientId));
  return {
    centre: { centreKey, name: c.name, suburb: c.suburb, state: c.state, rtPersonId: client?.primaryUserId || null },
    bookings: {
      historyFrom: day(bookings.map(b => b.bookingDate).filter(Boolean).sort()[0]),
      first: past[0] ? day(past[0].bookingDate) : null, last: lastPast ? day(lastPast.bookingDate) : null,
      total: past.length, upcoming: live.length - past.length, last4Weeks: last4w,
      perMonth: Object.values(perMonth).sort((a, b) => a.month.localeCompare(b.month))
    },
    educators,
    emails: { connected: emails.connected, note: emails.note || null, count: emails.messages.length },
    timeline: ev.reverse()
  };
}

module.exports = { buildCentreHistory };
