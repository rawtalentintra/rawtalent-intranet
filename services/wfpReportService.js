// Weekly / monthly Workforce Partner report (Joy's "Proposals for Liam",
// section 1; built 23 Oct 2026). super_admin + Liam only for now.
// Sections:
//  A Activity per partner: this period vs last vs 4-period average.
//  B Funnel per partner: leads created in the period → called → visited →
//    centre set up → first booking → repeat; days visit → set-up; % of visits
//    followed up within 2 days; FBF offered → first booking → rebooked in 30 days.
//  C Centre health: status counts (dormantService.computeTrend) and change vs a
//    week earlier, top 5 declining with owner, outstanding Action Required.
//  D Bookings and fill per state, cancellations split centre / educator /
//    unfilled / admin (code mapping PROVISIONAL until Sophia confirms).
//  E Top 3 competitor/pricing points, needs and objections per state (Matrix).
// Saved to wfp_reports; generated Mondays 8am (last week) and on the 1st (last
// month). Emailing to Liam is built as a switch that stays OFF.
const { getDb } = require('../db/database');

const PARTNERS = { 'justine@rawtalent.com.au': 'Justine', 'gwen@rawtalent.com.au': 'Gwen', 'liam@rawtalent.com.au': 'Liam' };
const DAY = 864e5;
const melbDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Periods are Melbourne calendar days. Week = Monday–Sunday; month = calendar month.
function periodBounds(type, start) {
  if (type === 'month') {
    const [y, m] = start.slice(0, 7).split('-').map(Number);
    const s = `${y}-${String(m).padStart(2, '0')}-01`;
    const e = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return { start: s, end: e };
  }
  return { start, end: addDays(start, 7) };
}
function previousPeriods(type, start, n) {
  const out = []; let cur = start;
  for (let i = 0; i < n; i++) {
    if (type === 'month') { const [y, m] = cur.split('-').map(Number); cur = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; }
    else cur = addDays(cur, -7);
    out.push(periodBounds(type, cur));
  }
  return out;
}
function lastCompletedPeriod(type, now = new Date()) {
  const today = melbDay(now);
  if (type === 'month') { const [y, m] = today.split('-').map(Number); return periodBounds('month', m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`); }
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sun … 1 Mon
  const thisMonday = addDays(today, -((dow + 6) % 7));
  return periodBounds('week', addDays(thisMonday, -7));
}
const inP = (t, p) => { const d = melbDay(t); return d >= p.start && d < p.end; };

// Cancellation codes → who cancelled. PROVISIONAL (from RT notes, 16 Oct) until Sophia confirms.
const CANCEL_GROUP = {
  50: 'unfilled', 3: 'unfilled',
  7: 'centre', 9: 'centre', 10: 'centre', 11: 'centre', 12: 'centre', 13: 'centre', 14: 'centre', 15: 'centre', 16: 'centre', 17: 'centre', 22: 'centre', 47: 'centre', 48: 'centre',
  1: 'educator', 4: 'educator', 5: 'educator', 23: 'educator', 24: 'educator', 25: 'educator', 26: 'educator', 27: 'educator', 29: 'educator', 30: 'educator', 31: 'educator', 33: 'educator', 35: 'educator', 36: 'educator', 39: 'educator', 44: 'educator', 45: 'educator',
  2: 'admin', 6: 'admin', 28: 'admin', 49: 'admin', 51: 'admin'
};

async function buildReport(type = 'week', start = null) {
  const db = getDb();
  const q = (sql, args = []) => db.execute({ sql, args }).then(r => r.rows);
  const period = start ? periodBounds(type, start) : lastCompletedPeriod(type);
  const prevs = previousPeriods(type, period.start, 4);
  const all = [period, ...prevs];
  const since = prevs[prevs.length - 1].start;

  const leadsMod = require('../routes/leads');
  const centresMod = require('../routes/centres');
  const [stageEvents, centreVisits, leads, touchpoints, offers, leadRecs, centreRecs, notes, leadActs] = await Promise.all([
    leadsMod.buildStageEvents(),
    q(`SELECT channel, visit_date, lower(created_by_email) e FROM centre_visits WHERE status = 'completed' AND visit_date >= CAST(? AS date) - 1`, [since]),
    q(`SELECT id, centre_name, state, lower(submitted_by_email) e, created_at, lead_called_status, lead_called_at, centre_visited_status, centre_visited_at, signed_status, signed_at, centre_phone, contact_email, suburb FROM leads`),
    q(`SELECT lower(completed_by_email) e, completed_at, first_booking_free FROM dormant_touchpoints WHERE completed_at >= CAST(? AS date) - 1`, [since]).catch(() => []),
    q(`SELECT lower(offered_by_email) e, offered_at, centre_key, lead_id, booking_id, booking_date FROM first_booking_free_offers`).catch(() => []),
    q(`SELECT lower(uploaded_by_email) e, created_at FROM lead_recordings WHERE created_at >= CAST(? AS date) - 1`, [since]),
    q(`SELECT lower(uploaded_by_email) e, created_at FROM centre_recordings WHERE created_at >= CAST(? AS date) - 1`, [since]),
    q(`SELECT lead_id, lower(author_email) e, created_at FROM lead_notes WHERE created_at >= CAST(? AS date) - 30`, [since]),
    q(`SELECT lead_id, lower(created_by_email) e, created_at FROM lead_activities WHERE created_at >= CAST(? AS date) - 30`, [since]).catch(() => [])
  ]);

  // ── A Activity ──
  const partnerOf = e => PARTNERS[e] || null;
  const METRICS = ['leadCalls', 'centreCalls', 'leadVisits', 'centreVisits', 'leadsCreated', 'dormantTouchpoints', 'fbfOffers', 'voiceNotes'];
  const blank = () => Object.fromEntries(METRICS.map(m => [m, 0]));
  const act = all.map(() => ({ Justine: blank(), Gwen: blank(), Liam: blank() }));
  const add = (who, t, m) => { const p = partnerOf(who); if (!p || !t) return; all.forEach((per, i) => { if (inP(t, per)) act[i][p][m]++; }); };
  stageEvents.forEach(ev => add(ev.email, ev.at, ev.channel === 'visit' ? 'leadVisits' : 'leadCalls'));
  centreVisits.forEach(v => add(v.e, v.visit_date, v.channel === 'call' ? 'centreCalls' : 'centreVisits'));
  leads.forEach(l => add(l.e, l.created_at, 'leadsCreated'));
  touchpoints.forEach(t => add(t.e, t.completed_at, 'dormantTouchpoints'));
  offers.forEach(o => add(o.e, o.offered_at, 'fbfOffers'));
  [...leadRecs, ...centreRecs].forEach(r => add(r.e, r.created_at, 'voiceNotes'));
  const activity = ['Justine', 'Gwen', 'Liam'].map(p => ({
    partner: p,
    metrics: METRICS.map(m => {
      const prior = act.slice(1).map(a => a[p][m]);
      return { key: m, current: act[0][p][m], previous: act[1][p][m], avg4: Math.round(prior.reduce((x, y) => x + y, 0) / prior.length * 10) / 10 };
    })
  })).filter(r => r.partner !== 'Liam' || r.metrics.some(m => m.current || m.previous || m.avg4));

  // ── B Funnel (leads created in the period) ──
  const { centres, bookings, rawClients } = await centresMod.getCentresAndBookings();
  const match = require('./centreMatchService');
  const bookingsByKey = new Map();
  for (const b of bookings) {
    if (![1, 2, 3, 5].includes(b.statusId) || !b.bookingDate) continue;
    for (const k of [`loc:${b.locationId}`, `client:${b.clientId}`]) { if (!bookingsByKey.has(k)) bookingsByKey.set(k, []); bookingsByKey.get(k).push(new Date(b.bookingDate).getTime()); }
  }
  bookingsByKey.forEach(v => v.sort((a, b) => a - b));
  const followUps = new Map();
  [...notes, ...leadActs].forEach(n => { if (!followUps.has(n.lead_id)) followUps.set(n.lead_id, []); followUps.get(n.lead_id).push(new Date(n.created_at).getTime()); });
  const funnelFor = list => {
    const f = { leads: list.length, called: 0, visited: 0, setUp: 0, firstBooking: 0, repeat: 0, visitToSetUpDays: [], visitsInPeriod: 0, followedUp2d: 0 };
    for (const l of list) {
      if (l.lead_called_status === 'done') f.called++;
      if (l.centre_visited_status === 'done') f.visited++;
      const m = match.findConfidentMatch(l, rawClients);
      const key = m ? (m.rtLocationId ? `loc:${m.rtLocationId}` : `client:${m.rtClientId}`) : null;
      if (l.signed_status === 'signed' || key) f.setUp++;
      if (l.signed_status === 'signed' && l.signed_at && l.centre_visited_at) f.visitToSetUpDays.push((new Date(l.signed_at) - new Date(l.centre_visited_at)) / DAY);
      const bks = key ? (bookingsByKey.get(key) || []).filter(t => t >= new Date(l.created_at).getTime() && t <= Date.now()) : [];
      if (bks.length) f.firstBooking++;
      if (bks.length >= 2) f.repeat++;
    }
    const days = f.visitToSetUpDays.filter(d => d >= 0);
    f.avgDaysVisitToSetUp = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10 : null;
    delete f.visitToSetUpDays;
    return f;
  };
  const periodLeads = leads.filter(l => inP(l.created_at, period));
  const funnel = ['Justine', 'Gwen'].map(p => ({ partner: p, ...funnelFor(periodLeads.filter(l => partnerOf(l.e) === p)) }));
  funnel.push({ partner: 'All partners', ...funnelFor(periodLeads) });
  // Visits in the period followed up (note, call/visit log or stage change) within 2 days
  for (const row of funnel) {
    const vis = leads.filter(l => l.centre_visited_status === 'done' && l.centre_visited_at && inP(l.centre_visited_at, period) && (row.partner === 'All partners' || partnerOf(l.e) === row.partner));
    row.visitsInPeriod = vis.length;
    row.followedUp2d = vis.filter(l => {
      const v = new Date(l.centre_visited_at).getTime();
      const later = [...(followUps.get(l.id) || []), l.signed_at ? new Date(l.signed_at).getTime() : null].filter(Boolean);
      return later.some(t => t > v + 60 * 60 * 1000 && t <= v + 2 * DAY);
    }).length;
    row.followedUp2dPct = vis.length ? Math.round(row.followedUp2d / vis.length * 100) : null;
  }
  // FBF outcome (all offers to date): first booking after the offer → another booking within 30 days of it
  const fbf = { offered: offers.length, firstBooking: 0, rebooked30d: 0 };
  for (const o of offers) {
    let key = o.centre_key;
    if (!key && o.lead_id) { const l = leads.find(x => x.id === o.lead_id); const m = l && match.findConfidentMatch(l, rawClients); key = m ? (m.rtLocationId ? `loc:${m.rtLocationId}` : `client:${m.rtClientId}`) : null; }
    const bks = key ? (bookingsByKey.get(key) || []).filter(t => t >= new Date(o.offered_at).getTime() && t <= Date.now()) : [];
    if (bks.length) { fbf.firstBooking++; if (bks.some(t => t > bks[0] && t <= bks[0] + 30 * DAY)) fbf.rebooked30d++; }
  }

  // ── C Centre health ──
  const dormant = require('./dormantService');
  const idx = centresMod.indexBookingsByCentre(bookings);
  const assignments = await centresMod.getCentrePartnerAssignments();
  const withHealth = await centresMod.centresWithNurture();
  const lastByKey = await centresMod.getLastBookingDates(centres, bookings);
  const annotated = await dormant.annotateDormancy(withHealth.map(c => ({ ...c, bookingTrend: dormant.computeTrend(centresMod.bookingsForCentre(idx, c)) })), lastByKey);
  const weekAgo = Date.now() - 7 * DAY;
  const statusNow = {}, statusWeekAgo = {};
  const declining = [];
  let actionRequired = { unhappyClient: 0, goVisit: 0, dormant: 0 };
  for (const c of annotated) {
    const s = c.bookingTrend?.status || 'none';
    statusNow[s] = (statusNow[s] || 0) + 1;
    const prev = dormant.computeTrend(centresMod.bookingsForCentre(idx, c), weekAgo).status;
    statusWeekAgo[prev] = (statusWeekAgo[prev] || 0) + 1;
    if (s === 'declining') declining.push({ name: c.name, state: centresMod.shortState(c.state), owner: centresMod.partnerLabelForCentre(c, assignments), last4: c.bookingTrend.last4Weeks, prior8: c.bookingTrend.prior8Weeks });
    if (c.isEscalated) actionRequired.unhappyClient++;
    else if (c.bookingTrend?.status === 'new' && c.bookingTrend.firstBookingDaysAgo <= 21 && !(c.lastContactAt && String(c.lastContactAt).slice(0, 10) >= c.bookingTrend.firstBookingDate)) actionRequired.goVisit++;
    else if (c.dormantNeedsContact) actionRequired.dormant++;
  }
  declining.sort((a, b) => (b.prior8 / 2 - b.last4) - (a.prior8 / 2 - a.last4));
  const health = {
    statuses: ['growing', 'steady', 'new', 'declining', 'quiet', 'dormant'].map(s => ({ status: s, count: statusNow[s] || 0, change: (statusNow[s] || 0) - (statusWeekAgo[s] || 0) })),
    topDeclining: declining.slice(0, 5), actionRequired
  };

  // ── D Bookings and fill per state ──
  const stateOf = new Map(centres.map(c => [c.rtLocationId ? `loc:${c.rtLocationId}` : `client:${c.rtClientId}`, centresMod.shortState(c.state)]));
  const byState = {};
  for (const b of bookings) {
    const d = (b.bookingDate || '').slice(0, 10);
    if (!d || d < period.start || d >= period.end) continue;
    const st = stateOf.get(`loc:${b.locationId}`) || stateOf.get(`client:${b.clientId}`) || 'Other';
    const r = byState[st] = byState[st] || { state: st, booked: 0, filled: 0, unfilled: 0, open: 0, cancelled: { centre: 0, educator: 0, admin: 0, unclear: 0 } };
    r.booked++;
    if (b.statusId === 3 || b.statusId === 5) r.filled++;
    else if (b.statusId === 1 || b.statusId === 2) r.open++;
    else if (b.statusId === 7) r.unfilled++;
    else if (b.statusId === 6) {
      const g = CANCEL_GROUP[centresMod.lastCancelReason(b)] || 'unclear';
      if (g === 'unfilled') r.unfilled++; else r.cancelled[g]++;
    }
  }
  const fill = Object.values(byState).map(r => ({ ...r, fillRate: r.filled + r.unfilled ? Math.round(r.filled / (r.filled + r.unfilled) * 1000) / 10 : null }))
    .sort((a, b) => b.booked - a.booked);

  // ── E Intelligence Matrix highlights ──
  const matrix = [];
  try {
    const vi = require('./voiceInsightsService');
    for (const st of ['VIC', 'SA', 'QLD']) {
      const m = await vi.buildMatrix(st);
      const pick = k => ((m.cards || []).find(c => c.key === k)?.bullets || []).slice(0, 3).map(b => `${b.point}${b.count > 1 ? ` (×${b.count})` : ''}`);
      matrix.push({ state: st, recordings: m.recordings || 0, competitors: pick('competitors'), needs: pick('needs'), objections: pick('objections') });
    }
  } catch (err) { matrix.push({ error: err.message }); }

  return {
    type, period, previous: prevs[0], generatedAt: new Date().toISOString(),
    activity, funnel, fbf, health, fill, matrix,
    notes: [
      'Activity counts are credited to whoever logged them. Lead calls and visits come from lead stage changes (as on WFP Performance).',
      '"Centre set up" = signed, or matched to an RT centre. First booking and repeat are counted from the lead\'s creation date.',
      'Cancellation split uses the provisional RT reason-code mapping, pending Sophia\'s confirmation.',
      'HeartBeat holds about 12 months of RT bookings.'
    ]
  };
}

async function generateAndSave(type, start = null) {
  const r = await buildReport(type, start);
  await getDb().execute({
    sql: `INSERT INTO wfp_reports (period_type, period_start, period_end, data, generated_at) VALUES (?,?,?,?, now())
          ON CONFLICT (period_type, period_start) DO UPDATE SET data = excluded.data, period_end = excluded.period_end, generated_at = now()`,
    args: [type, r.period.start, r.period.end, JSON.stringify(r)]
  });
  return r;
}

// Scheduler hook: Mondays 8am Melbourne → last week; 1st of the month 8am → last month.
async function runScheduled(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(now).map(p => [p.type, p.value]));
  if (Number(parts.hour) !== 8) return [];
  const done = [];
  const exists = async (type, start) => (await getDb().execute({ sql: 'SELECT 1 FROM wfp_reports WHERE period_type = ? AND period_start = ?', args: [type, start] })).rows.length > 0;
  if (parts.weekday === 'Mon') { const p = lastCompletedPeriod('week', now); if (!(await exists('week', p.start))) { await generateAndSave('week', p.start); done.push(`week ${p.start}`); } }
  if (Number(parts.day) === 1) { const p = lastCompletedPeriod('month', now); if (!(await exists('month', p.start))) { await generateAndSave('month', p.start); done.push(`month ${p.start}`); } }
  // "Email to Liam" is a switch that stays OFF until Joy turns it on (wfp_report_settings.email_liam).
  return done;
}

module.exports = { buildReport, generateAndSave, runScheduled, lastCompletedPeriod, periodBounds, CANCEL_GROUP };
