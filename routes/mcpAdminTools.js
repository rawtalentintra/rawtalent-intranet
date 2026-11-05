// Read-only admin tools for HeartBeat's MCP server — leads and the WFP
// pipeline, bookings and fill rate, and JobAdder. Added
// 2026-10-09 so the company owner (Liam) can ask about the admin side from
// his own AI client. Everything here only reads: no tool changes data in
// HeartBeat, RT Portal or JobAdder. Only accounts that pass mcpTokenService.canUseMcp
// ever reach this file (see requireMcpToken in routes/mcp.js).
const { z } = require('zod');
const { getDb } = require('../db/database');
const jobAdderService = require('../services/jobAdderService');
const { getCentresAndBookings, computeFillRateByPartner, lastCancelReason } = require('./centres');

// RT Portal's own booking status names (RT's bookingStatus text). Filled = 2, 3 or 5.
const STATUS_NAMES = { 1: 'Created (open, no educator yet)', 2: 'Assigned (filled)', 3: 'Accepted (filled)', 5: 'Completed (filled)', 6: 'Cancelled', 7: 'Unfilled', 11: 'Requested (pending: centre asked for a named educator)' };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const text = t => ({ content: [{ type: 'text', text: t }] });
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');

async function jobAdderGet(path) {
  const token = await jobAdderService.getValidAccessToken();
  if (!token) throw new Error('JobAdder is not connected in HeartBeat.');
  const res = await fetch(`${token.apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
  if (!res.ok) throw new Error(`JobAdder call failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

async function customerIoGet(path) {
  const key = process.env.CUSTOMERIO_APP_API_KEY;
  if (!key) throw new Error('Customer.io is not connected: CUSTOMERIO_APP_API_KEY is not set in HeartBeat\'s environment.');
  const base = process.env.CUSTOMERIO_API_BASE || 'https://api.customer.io/v1';
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Customer.io call failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

function registerAdminTools(server) {
  // ── Educators (matches RT Portal's Candidates screen) ─────────────────
  const dir = require('../services/educatorDirectoryService');
  const csv = v => (v == null ? [] : String(v).split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  server.registerTool('list_educators', {
    title: 'List / Count Educators',
    description: 'Count and list RawTalent educators with RT Portal\'s own filters, e.g. "how many Active, Compliant educators are in VIC", "Actively Engaged educators within 10 km of Goodstart Brunswick", "Do Not Use educators in SA", "educators stuck at the Documents onboarding step". Every filter is optional and accepts one value or several separated by commas. Returns the total, a breakdown by status / compliance / engagement / state, and up to `limit` educators (nearest first when near is used). Status, onboarding and compliance match RT Portal exactly. Engagement comes from completed RT shifts (see get_educator_definitions).',
    inputSchema: {
      status: z.string().optional().describe('RT Portal status: Active, Vetting Call, In Progress, Awaiting Activation, Pending Reference, Student, Do Not Use, Not Interested'),
      compliant: z.boolean().optional().describe('true = Compliant, false = Not Compliant (as RT Portal shows it)'),
      state: z.string().optional().describe('VIC, SA, QLD, NSW, NT, ACT, WA, TAS'),
      engagement: z.string().optional().describe('Actively Working, Actively Engaged, Engaged, Disengaged, Dormant'),
      onboarding: z.string().optional().describe('RT onboarding step: Register, AboutUs, Profile Image, Experience, Emergency Contact, Qualification Level, Reference, Visa, Finance, Tax, Documents, Complete'),
      qualification: z.string().optional().describe('Part of the qualification name, e.g. Diploma, Cert III, ECT'),
      gender: z.string().optional().describe('Female, Male, Other, Not stated'),
      suburb: z.string().optional().describe('Home suburb (exact name)'),
      near: z.string().optional().describe('A centre name (from RT) or any street address/suburb; returns educators living within radiusKm of it'),
      radiusKm: z.number().min(1).max(100).optional().describe('Radius for near, default 10'),
      workedSince: z.string().optional().describe('Only educators with a completed shift on/after this date (YYYY-MM-DD)'),
      limit: z.number().int().min(0).max(500).optional().describe('How many educators to list, default 50 (0 = counts only)')
    }
  }, async (q) => {
    const { list } = await dir.getDirectory();
    let origin = null;
    if (q.near) {
      const { centres } = await getCentresAndBookings();
      const needle = q.near.toLowerCase();
      const c = centres.find(x => (x.name || '').toLowerCase() === needle) || centres.find(x => (x.name || '').toLowerCase().includes(needle));
      if (c) {
        const g = (await require('../services/centreGeoService').getGeocodesForCentres([c]))[c.centreKey];
        if (g) origin = { lat: g.lat, lng: g.lng, label: `${c.name}${c.suburb ? ', ' + c.suburb : ''} (RT centre)` };
      }
      if (!origin) {
        const coord = await require('../services/mapboxService').geocodeAddress(`${q.near}, Australia`).catch(() => null);
        if (coord) origin = { lat: coord.lat, lng: coord.lng, label: `${q.near} (address)` };
      }
      if (!origin) return text(`Couldn't find a centre or address matching "${q.near}".`);
    }
    const km = (a, b) => require('../services/mapboxService').haversineKm(a, b);
    const want = { status: csv(q.status), state: csv(q.state), engagement: csv(q.engagement), onboarding: csv(q.onboarding), gender: csv(q.gender) };
    const radius = q.radiusKm || 10;
    let rows = list.filter(e =>
      (!want.status.length || want.status.includes(e.status.toLowerCase())) &&
      (!want.state.length || want.state.includes((e.state || '').toLowerCase())) &&
      (!want.engagement.length || want.engagement.includes(e.engagement.toLowerCase())) &&
      (!want.onboarding.length || want.onboarding.includes(e.onboarding.toLowerCase()) || (want.onboarding.includes('completed') && e.onboarding === 'Complete')) &&
      (!want.gender.length || want.gender.includes(e.gender.toLowerCase())) &&
      (q.compliant == null || e.compliant === q.compliant) &&
      (!q.qualification || (e.qualification || '').toLowerCase().includes(q.qualification.toLowerCase().replace('cert iii', 'certiii'))) &&
      (!q.suburb || (e.suburb || '').toLowerCase() === q.suburb.toLowerCase()) &&
      (!isDay(q.workedSince) || (e.lastShift && e.lastShift >= q.workedSince)));
    if (origin) {
      rows = rows.filter(e => e.lat != null).map(e => ({ ...e, distanceKm: km(origin, e) })).filter(e => e.distanceKm <= radius).sort((a, b) => a.distanceKm - b.distanceKm);
    }
    const tally = key => { const t = {}; rows.forEach(e => { const k = key(e) || 'unknown'; t[k] = (t[k] || 0) + 1; }); return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '); };
    const head = [
      `${rows.length} educator(s)${origin ? ` within ${radius} km of ${origin.label}` : ''}.`,
      `By RT status: ${tally(e => e.status)}`,
      `By compliance: ${tally(e => (e.compliant ? 'Compliant' : 'Not Compliant'))}`,
      `By engagement: ${tally(e => e.engagement)}`,
      origin ? null : `By state: ${tally(e => e.state)}`
    ].filter(Boolean).join('\n');
    const n = q.limit == null ? 50 : q.limit;
    if (!n || !rows.length) return text(head);
    const body = rows.slice(0, n).map(e => `• ${e.name} (id ${e.id}) — ${e.status} · ${e.compliant ? 'Compliant' : 'Not Compliant'} · ${e.engagement} · onboarding ${e.onboarding} · ${[e.suburb, e.state].filter(Boolean).join(', ')}${e.distanceKm != null ? ` · ${e.distanceKm.toFixed(1)} km` : ''} · last shift ${e.lastShift || 'never'} · ${e.phone || 'no phone'}`).join('\n');
    return text(`${head}\n\n${rows.length > n ? `First ${n}:` : 'Educators:'}\n${body}`);
  });

  server.registerTool('get_educator_definitions', {
    title: 'Educator Status Definitions',
    description: 'What each educator status, onboarding step, compliance result and engagement group means in RawTalent, and where the data comes from. Use this before explaining numbers from list_educators.',
    inputSchema: {}
  }, async () => text([
    'RT Portal status (set by the RawTalent team in RT Portal): Vetting Call = applied, waiting for the vetting call; In Progress = onboarding underway; Pending Reference = waiting on references; Awaiting Activation = onboarded, waiting to be activated; Active = can be booked; Student = student educator; Do Not Use = banned from bookings; Not Interested = no longer wants work.',
    'Onboarding step: the step of the RT app sign-up the educator has reached (Register, AboutUs, Profile Image, Experience, Emergency Contact, Qualification Level, Reference, Visa, Finance, Tax, Documents, Complete).',
    'Compliance: Compliant / Not Compliant exactly as RT Portal shows it. For Not Compliant educators, get_educator lists the reasons HeartBeat can see (expired or unreviewed documents, missing core documents, visa).',
    'Engagement (from completed RT shifts): ' + Object.entries(dir.ENGAGEMENT_DEFS).map(([k, v]) => `${k} = ${v}`).join('; ') + '.',
    'Ready to roster (as used in Micropods): RT status Active, onboarding Complete and Compliant.',
    'Freshness: HeartBeat copies RT every 2 hours 8am-8pm Melbourne time and overnight.'
  ].join('\n\n')));

  // ── Leads / WFP pipeline ──────────────────────────────────────────────
  server.registerTool('search_leads', {
    title: 'Search Leads',
    description: 'Search the Workforce Partner leads/centres pipeline by centre name or suburb, optionally filtered by state or assigned partner. Shows each lead\'s called / visited / signed stage and who it is assigned to. Use get_lead with the id for notes and activity.',
    inputSchema: {
      query: z.string().optional().describe('Part of the centre name or suburb'),
      state: z.string().optional().describe('VIC, SA, QLD, etc.'),
      partner: z.string().optional().describe('Assigned partner first name, e.g. Justine or Gwen'),
      limit: z.number().int().min(1).max(50).optional()
    }
  }, async ({ query, state, partner, limit }) => {
    const where = []; const args = [];
    if (query) { where.push('(centre_name ILIKE ? OR suburb ILIKE ?)'); args.push(`%${query}%`, `%${query}%`); }
    if (state) { where.push('upper(state) = ?'); args.push(state.toUpperCase()); }
    if (partner) { where.push('assigned_workforce_partner ILIKE ?'); args.push(partner); }
    const rows = (await getDb().execute({
      sql: `SELECT id, centre_name, suburb, state, assigned_workforce_partner, entry_type, lead_called_status, lead_called_at,
                   centre_visited_status, centre_visited_at, signed_status, signed_at
            FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`,
      args: [...args, limit || 20]
    })).rows;
    if (!rows.length) return text('No leads matched.');
    return text(rows.map(l => `• ${l.centre_name} (id ${l.id}) — ${[l.suburb, l.state].filter(Boolean).join(', ')} · partner: ${l.assigned_workforce_partner || 'unassigned'} · called: ${l.lead_called_status}${l.lead_called_at ? ' ' + day(l.lead_called_at) : ''} · visited: ${l.centre_visited_status}${l.centre_visited_at ? ' ' + day(l.centre_visited_at) : ''} · signed: ${l.signed_status}${l.signed_at ? ' ' + day(l.signed_at) : ''}`).join('\n'));
  });

  server.registerTool('get_lead', {
    title: 'Get Lead Details',
    description: 'Full detail for one lead by id (from search_leads): contact, who submitted it, stages, notes and the logged calls/visits.',
    inputSchema: { id: z.string() }
  }, async ({ id }) => {
    const db = getDb();
    const lead = (await db.execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [id] })).rows[0];
    if (!lead) return text(`No lead with id ${id}.`);
    const notes = (await db.execute({ sql: 'SELECT note, author_name, created_at FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC LIMIT 15', args: [id] })).rows;
    const recs = (await db.execute({ sql: 'SELECT uploaded_by_name, created_at, summary, transcript FROM lead_recordings WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10', args: [id] })).rows;
    const acts = (await db.execute({ sql: 'SELECT channel, contact_name, outcome, notes, next_step, created_by_name, created_at FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 15', args: [id] })).rows;
    const lines = [
      `${lead.centre_name} (id ${lead.id}) — ${[lead.street_address, lead.suburb, lead.state].filter(Boolean).join(', ')}`,
      `Contact: ${[lead.contact_first_name, lead.contact_last_name].filter(Boolean).join(' ') || '—'}${lead.centre_phone ? ' · ' + lead.centre_phone : ''}${lead.contact_email ? ' · ' + lead.contact_email : ''}`,
      `Submitted by ${lead.submitted_by_name || lead.submitted_by_email} on ${day(lead.created_at)} · assigned partner: ${lead.assigned_workforce_partner || 'unassigned'} · type: ${lead.entry_type}`,
      `Stages — called: ${lead.lead_called_status} ${day(lead.lead_called_at)} · visited: ${lead.centre_visited_status} ${day(lead.centre_visited_at)} · signed: ${lead.signed_status} ${day(lead.signed_at)}`,
      `Notes (${notes.length}):`, ...notes.map(n => `  - ${day(n.created_at)} ${n.author_name || ''}: ${n.note}`),
      `Voice notes (${recs.length}):`, ...recs.map(v => `  - ${day(v.created_at)} ${v.uploaded_by_name || ''}: ${v.summary || (v.transcript ? String(v.transcript).slice(0, 600) : '(not transcribed yet)')}`),
      `Logged calls/visits (${acts.length}):`, ...acts.map(a => `  - ${day(a.created_at)} ${a.channel} by ${a.created_by_name || '—'}${a.contact_name ? ' with ' + a.contact_name : ''}${a.outcome ? ' [' + a.outcome + ']' : ''}${a.notes ? ': ' + a.notes : ''}${a.next_step ? ' → next: ' + a.next_step : ''}`)
    ];
    return text(lines.join('\n'));
  });

  server.registerTool('get_leads_funnel', {
    title: 'Leads Funnel',
    description: 'Counts of leads called, centres visited and leads signed in a date range (by the date each stage was marked done), split by state, plus new leads created. Dates are YYYY-MM-DD, "to" is exclusive; defaults to the last 30 days.',
    inputSchema: { from: z.string().optional(), to: z.string().optional() }
  }, async ({ from, to }) => {
    const dayMs = 86400000;
    const f = isDay(from) ? from : new Date(Date.now() - 30 * dayMs).toISOString().slice(0, 10);
    const t = isDay(to) ? to : new Date(Date.now() + dayMs).toISOString().slice(0, 10);
    const rows = (await getDb().execute({
      sql: `SELECT coalesce(upper(state), 'unknown') AS state,
              COUNT(*) FILTER (WHERE created_at >= CAST(? AS date) AND created_at < CAST(? AS date)) AS created,
              COUNT(*) FILTER (WHERE lead_called_status = 'done' AND lead_called_at >= CAST(? AS date) AND lead_called_at < CAST(? AS date)) AS called,
              COUNT(*) FILTER (WHERE centre_visited_status = 'done' AND centre_visited_at >= CAST(? AS date) AND centre_visited_at < CAST(? AS date)) AS visited,
              COUNT(*) FILTER (WHERE signed_status = 'signed' AND signed_at >= CAST(? AS date) AND signed_at < CAST(? AS date)) AS signed
            FROM leads GROUP BY 1 ORDER BY 1`,
      args: [f, t, f, t, f, t, f, t]
    })).rows;
    const body = rows.map(r => `${r.state}: ${r.created} new · ${r.called} called · ${r.visited} visited · ${r.signed} signed`).join('\n');
    return text(`Leads funnel ${f} to ${t} (exclusive):\n${body}\n\nNote: this counts stage dates only. It does not say who did the work, and logging by partners has been patchy, so treat low numbers as "not logged" rather than "not done".`);
  });

  // ── Bookings / fill rate ──────────────────────────────────────────────
  server.registerTool('get_fill_rate', {
    title: 'Fill Rate by Partner',
    description: 'Booking fill rate by Workforce Partner (Justine, Gwen, Unassigned) for a date range of shift dates. Fill rate = filled / (filled + unfilled). "Unfilled" is inferred from RT cancel reason 50, so it reads lower than the weekly ops figure. Dates are YYYY-MM-DD, "to" exclusive; defaults to the last 30 days.',
    inputSchema: { from: z.string().optional(), to: z.string().optional() }
  }, async ({ from, to }) => {
    const r = await computeFillRateByPartner(from, to);
    const line = p => `${p.partner}: ${p.fillRate == null ? 'n/a' : p.fillRate + '%'} (filled ${p.filled}, unfilled ${p.unfilled}, cancelled ${p.cancelled}, open ${p.open}, ${p.centres} centres)`;
    return text(`Fill rate ${r.from} to ${r.to} (exclusive)\n${r.partners.map(line).join('\n')}\n${line(r.total)}`);
  });

  server.registerTool('get_bookings_summary', {
    title: 'Bookings Summary (matches RT Portal dashboard)',
    description: 'Exact booking totals for one day or a date range (shift date, Melbourne time), counted the same way as RT Portal\'s dashboard ("Filled Booking 69/69" = filled out of all bookings that aren\'t cancelled). Returns total, filled (assigned + accepted + completed), still open (created, no educator yet), cancelled and unfilled, plus shift start/finish times and average shift length. Optional state (VIC, SA, QLD...) or centreKey. Use this for any "how many bookings" question; defaults to today.',
    inputSchema: {
      date: z.string().optional().describe('One day, YYYY-MM-DD (default today, Melbourne)'),
      from: z.string().optional().describe('Range start YYYY-MM-DD (use with to instead of date)'),
      to: z.string().optional().describe('Range end YYYY-MM-DD, exclusive'),
      state: z.string().optional(), centreKey: z.string().optional()
    }
  }, async ({ date, from, to, state, centreKey }) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
    let f, t;
    if (isDay(from) || isDay(to)) { f = isDay(from) ? from : today; t = isDay(to) ? to : null; }
    else { f = isDay(date) ? date : today; t = null; }
    const { bookings, centres } = await getCentresAndBookings();
    const stateOf = new Map(centres.map(c => [c.centreKey, String(c.state || '')]));
    const short = st => ({ victoria: 'VIC', 'south australia': 'SA', queensland: 'QLD', 'new south wales': 'NSW', 'northern territory': 'NT', 'australian capital territory': 'ACT', 'western australia': 'WA', tasmania: 'TAS' })[st.toLowerCase()] || st.toUpperCase();
    const rows = bookings.filter(b => {
      const d = (b.bookingDate || '').slice(0, 10);
      if (!d || (t ? (d < f || d >= t) : d !== f)) return false;
      const key = b.locationId != null ? `loc:${b.locationId}` : `client:${b.clientId}`;
      if (centreKey && key !== centreKey && `client:${b.clientId}` !== centreKey) return false;
      if (state && short(stateOf.get(key) || stateOf.get(`client:${b.clientId}`) || '') !== state.toUpperCase()) return false;
      return true;
    });
    const n = { created: 0, requested: 0, assigned: 0, accepted: 0, completed: 0, cancelled: 0, unfilled: 0 };
    const mins = [], starts = [], ends = [];
    for (const b of rows) {
      const uf = b.statusId === 7 || (b.statusId === 6 && lastCancelReason(b) === 50);
      if (uf) n.unfilled++; else if (b.statusId === 6) n.cancelled++;
      else if (b.statusId === 1) n.created++; else if (b.statusId === 11) n.requested++; else if (b.statusId === 2) n.assigned++; else if (b.statusId === 3) n.accepted++; else if (b.statusId === 5) n.completed++;
      if ([2, 3, 5].includes(b.statusId) && b.startTime && b.endTime) {
        const s = new Date(b.startTime), e = new Date(b.endTime);
        const m = (e - s) / 60000; if (m > 0 && m < 24 * 60) { mins.push(m - (Number(b.unpaidBreak) || 0)); starts.push(s.getHours() * 60 + s.getMinutes()); ends.push(e.getHours() * 60 + e.getMinutes()); }
      }
    }
    const filled = n.assigned + n.accepted + n.completed;
    const live = rows.length - n.cancelled - n.unfilled;
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const clock = m => (m == null ? 'n/a' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`);
    const dur = avg(mins);
    const label = t ? `${f} to ${t} (exclusive)` : f;
    return text([
      `Bookings ${label}${state ? ' · ' + state.toUpperCase() : ''}${centreKey ? ' · ' + centreKey : ''}`,
      `Filled ${filled}/${live} (RT Portal dashboard style: filled out of all non-cancelled bookings)`,
      `Total bookings: ${rows.length}`,
      `Filled: ${filled} (assigned ${n.assigned}, accepted ${n.accepted}, completed ${n.completed})`,
      `Open, no educator yet: ${n.created}`,
      `Requested (centre asked for a named educator, not assigned yet): ${n.requested}`,
      `Cancelled: ${n.cancelled}`,
      `Unfilled (RT couldn't fill): ${n.unfilled}`,
      `Filled shifts: average start ${clock(avg(starts))}, average finish ${clock(avg(ends))}, average length ${dur == null ? 'n/a' : (dur / 60).toFixed(1) + ' h'} (after unpaid break)`,
      'Source: RT bookings, refreshed every few minutes.'
    ].join('\n'));
  });

  server.registerTool('get_profitability', {
    title: 'Booking Profitability (pay rate, charge rate, margin)',
    description: 'Revenue, educator pay cost, gross profit and margin for filled RT bookings (assigned, accepted, completed) over a day or date range, straight from RT\'s own booking financials: charge rate per hour, pay rate per hour, paid hours, booking revenue, educator pay cost and gross profit. Breaks down by client (centre) or by state, sorted by gross profit, with average pay rate, average charge rate and margin %. Gross profit is charge minus educator pay as RT calculates it; it does NOT include on-costs (super, workers comp, payroll tax). Defaults to today (Melbourne).',
    inputSchema: {
      date: z.string().optional().describe('One day, YYYY-MM-DD (default today)'),
      from: z.string().optional(), to: z.string().optional().describe('Range end YYYY-MM-DD, exclusive'),
      groupBy: z.enum(['client', 'state', 'none']).optional().describe('Breakdown, default client'),
      state: z.string().optional(), limit: z.number().int().min(1).max(200).optional().describe('Rows in the breakdown, default 50')
    }
  }, async ({ date, from, to, groupBy, state, limit }) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
    let f, t;
    if (isDay(from) || isDay(to)) { f = isDay(from) ? from : today; t = isDay(to) ? to : null; } else { f = isDay(date) ? date : today; t = null; }
    const { bookings, centres } = await getCentresAndBookings();
    const cByKey = new Map(centres.map(c => [c.centreKey, c]));
    const shortSt = v => ({ victoria: 'VIC', 'south australia': 'SA', queensland: 'QLD', 'new south wales': 'NSW', 'northern territory': 'NT', 'australian capital territory': 'ACT', 'western australia': 'WA', tasmania: 'TAS' })[String(v || '').toLowerCase()] || String(v || 'Unknown').toUpperCase();
    const rows = bookings.filter(b => {
      const d = (b.bookingDate || '').slice(0, 10);
      if (!d || (t ? (d < f || d >= t) : d !== f) || ![2, 3, 5].includes(b.statusId)) return false;
      if (state) { const c = cByKey.get(`loc:${b.locationId}`) || cByKey.get(`client:${b.clientId}`); if (shortSt(c && c.state) !== state.toUpperCase()) return false; }
      return true;
    });
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const add = (acc, b) => { acc.n++; acc.hours += num(b.paidHours); acc.rev += num(b.bookingRevenue); acc.cost += num(b.educatorPayCost); acc.gp += num(b.grossProfit); acc.pay += num(b.payRate); acc.charge += num(b.chargeRate); return acc; };
    const blank = () => ({ n: 0, hours: 0, rev: 0, cost: 0, gp: 0, pay: 0, charge: 0 });
    const total = rows.reduce(add, blank());
    const money = v => '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const line = (name, a) => `${name}: ${a.n} shifts · ${a.hours.toFixed(1)} h · revenue ${money(a.rev)} · educator pay ${money(a.cost)} · gross profit ${money(a.gp)} · margin ${a.rev ? (a.gp / a.rev * 100).toFixed(1) : '0.0'}% · avg charge ${money(a.n ? a.charge / a.n : 0)}/h · avg pay ${money(a.n ? a.pay / a.n : 0)}/h`;
    const out = [`Profitability ${t ? `${f} to ${t} (exclusive)` : f}${state ? ' · ' + state.toUpperCase() : ''} (filled bookings only; RT's figures, before on-costs)`, line('TOTAL', total)];
    const g = groupBy || 'client';
    if (g !== 'none' && rows.length) {
      const by = new Map();
      for (const b of rows) {
        const c = cByKey.get(`loc:${b.locationId}`) || cByKey.get(`client:${b.clientId}`);
        const k = g === 'state' ? shortSt(c && c.state) : (b.locationName || b.clientName || (c && c.name) || `centre ${b.locationId || b.clientId}`);
        if (!by.has(k)) by.set(k, blank());
        add(by.get(k), b);
      }
      out.push('', `By ${g} (highest gross profit first):`, ...[...by.entries()].sort((a, b) => b[1].gp - a[1].gp).slice(0, limit || 50).map(([k, a]) => line('• ' + k, a)));
    }
    return text(out.join('\n'));
  });

  server.registerTool('search_bookings', {
    title: 'Search Bookings',
    description: 'List individual RT bookings (shifts) with date, start and finish time, hours, centre, educator and RT Portal status. Filter by centreKey (from search_centres), status and a shift-date range (YYYY-MM-DD, "to" exclusive). Statuses as RT Portal names them: created (no educator yet), assigned, accepted, completed (these three = filled), cancelled, unfilled. Returns at most 50 rows, so NEVER count bookings with this tool: use get_bookings_summary for totals.',
    inputSchema: {
      centreKey: z.string().optional(),
      status: z.enum(['filled', 'created', 'requested', 'assigned', 'accepted', 'completed', 'cancelled', 'unfilled']).optional().describe('filled = assigned + accepted + completed (an educator is on it); created = no educator yet'),
      from: z.string().optional(), to: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional()
    }
  }, async ({ centreKey, status, from, to, limit }) => {
    const { bookings, centres } = await getCentresAndBookings();
    const wanted = status ? { created: 1, requested: 11, assigned: 2, accepted: 3, completed: 5, cancelled: 6, unfilled: 7, filled: -1 }[status] : null;
    const nameByKey = new Map(centres.map(c => [c.centreKey, c.name]));
    const rows = bookings.filter(b => {
      const d = (b.bookingDate || '').slice(0, 10);
      if (isDay(from) && d < from) return false;
      if (isDay(to) && d >= to) return false;
      if (wanted) {
        // RT records most unfilled shifts as Cancelled with cancel reason 50 ("unfilled").
        const unfilled = b.statusId === 7 || (b.statusId === 6 && lastCancelReason(b) === 50);
        if (status === 'filled' ? ![2, 3, 5].includes(b.statusId) : status === 'unfilled' ? !unfilled : (b.statusId !== wanted || (status === 'cancelled' && unfilled))) return false;
      }
      if (centreKey) { const k = `loc:${b.locationId}`; if (k !== centreKey && `client:${b.clientId}` !== centreKey) return false; }
      return true;
    }).sort((a, b) => String(b.bookingDate).localeCompare(String(a.bookingDate))).slice(0, limit || 20);
    if (!rows.length) return text('No bookings matched.');
    const hm = t => (t ? String(t).slice(11, 16) : '?');
    return text(rows.map(b => `• ${(b.bookingDate || '').slice(0, 10)} ${hm(b.startTime)}-${hm(b.endTime)}${b.paidHours ? ` (${b.paidHours}h paid)` : ''}${b.chargeRate ? ` · charge $${b.chargeRate}/h, pay $${b.payRate}/h` : ''} · ${nameByKey.get(`loc:${b.locationId}`) || nameByKey.get(`client:${b.clientId}`) || `centre ${b.locationId || b.clientId}`} · ${(b.statusId === 6 && lastCancelReason(b) === 50) ? 'Unfilled' : (STATUS_NAMES[b.statusId] || 'status ' + b.statusId)}${b.assignedCandidateName ? ' · ' + b.assignedCandidateName : ''} (booking ${b.clientBookingId})`).join('\n'));
  });

  // ── JobAdder (read-only) ──────────────────────────────────────────────
  server.registerTool('jobadder_search_candidates', {
    title: 'JobAdder: Search Candidates',
    description: 'Search JobAdder candidates by keyword (name, skills, resume text), optionally limited to a state. Returns name, location, contact and candidateId for jobadder_get_candidate.',
    inputSchema: { keywords: z.string(), state: z.string().optional(), limit: z.number().int().min(1).max(25).optional() }
  }, async ({ keywords, state, limit }) => {
    const p = new URLSearchParams({ Keywords: keywords, Limit: String(limit || 10) });
    if (state) p.set('State', state);
    const data = await jobAdderGet(`/candidates?${p.toString()}`);
    const items = data.items || [];
    if (!items.length) return text('No JobAdder candidates matched.');
    return text(items.map(c => `• ${c.firstName || ''} ${c.lastName || ''} (candidateId ${c.candidateId}) — ${[c.address?.suburb, c.address?.state].filter(Boolean).join(', ') || 'no address'}${c.mobile ? ' · ' + c.mobile : ''}${c.email ? ' · ' + c.email : ''}`).join('\n'));
  });

  server.registerTool('jobadder_get_candidate', {
    title: 'JobAdder: Get Candidate',
    description: 'Full JobAdder record for one candidate by candidateId: contact details, status, education and recent employment.',
    inputSchema: { candidateId: z.string() }
  }, async ({ candidateId }) => {
    const c = await jobAdderGet(`/candidates/${encodeURIComponent(candidateId)}`);
    const edu = (c.education || []).slice(0, 5).map(e => `  - ${e.course || e.institution || ''}${e.institution && e.course ? ', ' + e.institution : ''}${e.date ? ' (' + String(e.date).slice(0, 4) + ')' : ''}`);
    const emp = (c.employment?.history || []).slice(0, 5).map(e => `  - ${e.position || ''} at ${e.employer || ''}${e.start ? ' (' + String(e.start).slice(0, 4) + ')' : ''}`);
    return text([
      `${c.firstName || ''} ${c.lastName || ''} (candidateId ${c.candidateId})`,
      `Contact: ${[c.mobile, c.email].filter(Boolean).join(' · ') || '—'}`,
      `Location: ${[c.address?.street?.[0], c.address?.suburb, c.address?.state].filter(Boolean).join(', ') || '—'}`,
      c.status?.name ? `Status: ${c.status.name}` : null,
      edu.length ? 'Education:\n' + edu.join('\n') : null,
      emp.length ? 'Recent employment:\n' + emp.join('\n') : null
    ].filter(Boolean).join('\n'));
  });

  server.registerTool('jobadder_open_ads', {
    title: 'JobAdder: Open Job Ads',
    description: 'List the job ads currently open in JobAdder with their reference, owner and post/expiry dates, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(50).optional() }
  }, async ({ limit }) => {
    const items = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const data = await jobAdderGet(`/jobads?limit=100&offset=${offset}`);
      const page = data.items || [];
      items.push(...page);
      if (page.length < 100 || offset + 100 >= (data.totalCount ?? 0)) break;
    }
    const open = items.filter(a => a.state === 'Current').sort((a, b) => new Date(b.postAt) - new Date(a.postAt)).slice(0, limit || 20);
    if (!open.length) return text('No open JobAdder ads.');
    return text(open.map(a => `• ${a.title || '(untitled)'} (adId ${a.adId}${a.reference ? ', ref ' + a.reference : ''}) — posted ${day(a.postAt)}, expires ${day(a.expireAt)}${a.owner ? ', owner ' + [a.owner.firstName, a.owner.lastName].filter(Boolean).join(' ') : ''}`).join('\n'));
  });

  server.registerTool('jobadder_ad_applicants', {
    title: 'JobAdder: Ad Applicants',
    description: 'Applicants for one JobAdder ad by adId (from jobadder_open_ads): name, contact, stage, source and applied date.',
    inputSchema: { adId: z.string(), limit: z.number().int().min(1).max(50).optional() }
  }, async ({ adId, limit }) => {
    const data = await jobAdderGet(`/jobads/${encodeURIComponent(adId)}/applications?limit=${limit || 25}&offset=0`);
    const items = data.items || [];
    if (!items.length) return text('No applicants for that ad.');
    return text(`${data.totalCount ?? items.length} applicants in total; showing ${items.length}:\n` + items.map(a => `• ${`${a.candidate?.firstName || ''} ${a.candidate?.lastName || ''}`.trim() || '(no name)'} (candidateId ${a.candidate?.candidateId}) — ${a.status?.name || 'no status'}, via ${a.source || 'unknown'}, applied ${day(a.createdAt)}${a.candidate?.mobile ? ' · ' + a.candidate.mobile : ''}`).join('\n'));
  });


  // ── Customer.io (read-only) ───────────────────────────────────────────
  // Needs CUSTOMERIO_APP_API_KEY (an App API key) set in Railway; until it is,
  // these report "not connected". GET requests only — nothing here can change
  // a campaign, email, segment or person in Customer.io.
  server.registerTool('customerio_list', {
    title: 'Customer.io: List',
    description: 'List Customer.io items (read-only): "automations" (campaigns, with state), "broadcasts", "transactional" messages, or "segments".',
    inputSchema: { what: z.enum(['automations', 'broadcasts', 'transactional', 'segments']) }
  }, async ({ what }) => {
    const path = { automations: '/campaigns', broadcasts: '/newsletters', transactional: '/transactional', segments: '/segments' }[what];
    const data = await customerIoGet(path);
    const items = data.campaigns || data.newsletters || data.messages || data.segments || [];
    if (!items.length) return text(`No ${what} returned.`);
    return text(items.slice(0, 60).map(i => `• ${i.name || '(unnamed)'} (id ${i.id})${i.state ? ' — ' + i.state : ''}${i.active === false ? ' — inactive' : ''}${i.updated ? ', updated ' + day(i.updated * 1000) : ''}`).join('\n'));
  });

  server.registerTool('customerio_get_person', {
    title: 'Customer.io: Find Person',
    description: 'Look up one person in Customer.io by exact email (read-only): returns their attributes.',
    inputSchema: { email: z.string() }
  }, async ({ email }) => {
    const found = await customerIoGet(`/customers?email=${encodeURIComponent(email)}`);
    const id = found.results?.[0]?.cio_id || found.results?.[0]?.id;
    if (!id) return text(`No Customer.io person found for ${email}.`);
    const attrs = await customerIoGet(`/customers/${encodeURIComponent(id)}/attributes`);
    const a = attrs.customer?.attributes || {};
    return text(`${email} (id ${id})\n` + Object.entries(a).slice(0, 40).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
  });

  // ── WFP Performance (same numbers as the WFP Performance page) ────────
  server.registerTool('get_wfp_performance', {
    title: 'WFP Performance by Partner',
    description: 'Workforce Partner performance for a date range (YYYY-MM-DD, "to" exclusive; default last 30 days): calls and visits per partner (lead stage changes + logged lead activity + logged centre calls/visits, de-duplicated exactly like the WFP Performance page), leads created, unattributed activity, and the leads funnel by state. Use get_fill_rate for booking fill rate and get_call_insights for what centres told partners.',
    inputSchema: { from: z.string().optional(), to: z.string().optional() }
  }, async ({ from, to }) => {
    const dayMs = 86400000;
    const F = new Date((isDay(from) ? from : new Date(Date.now() - 30 * dayMs).toISOString().slice(0, 10)) + 'T00:00:00+10:00');
    const T = new Date((isDay(to) ? to : new Date(Date.now() + dayMs).toISOString().slice(0, 10)) + 'T00:00:00+10:00');
    const inP = d => { if (!d) return false; const x = new Date(d); return x >= F && x < T; };
    const { buildStageEvents, buildActivitiesLog } = require('./leads');
    const [ev, log] = await Promise.all([buildStageEvents(), buildActivitiesLog()]);
    const dayKey = d => new Date(d).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' });
    const when = a => a.occurred_at || a.created_at;
    const logged = new Set(log.map(a => `${a.lead_id}|${a.channel}|${dayKey(when(a))}`));
    const events = log.filter(a => inP(when(a))).map(a => ({ email: String(a.created_by_email || '').toLowerCase(), channel: a.channel }));
    ev.forEach(e => { if (inP(e.at) && !logged.has(`${e.lead_id}|${e.channel}|${dayKey(e.at)}`)) events.push({ email: e.email, channel: e.channel }); });
    const db = getDb();
    const centreActs = (await db.execute({ sql: "SELECT lower(created_by_email) email, channel, visit_date FROM centre_visits WHERE status = 'completed'", args: [] })).rows.filter(v => inP(v.visit_date));
    const leadsCreated = (await db.execute({ sql: 'SELECT lower(submitted_by_email) email, created_at FROM leads', args: [] })).rows.filter(l => inP(l.created_at));
    const partners = [['Justine', 'justine@rawtalent.com.au'], ['Gwen', 'gwen@rawtalent.com.au']];
    const known = new Set(partners.map(p => p[1]));
    const lines = partners.map(([n, e]) => {
      const lc = events.filter(x => x.email === e && x.channel === 'call').length, lv = events.filter(x => x.email === e && x.channel === 'visit').length;
      const cc = centreActs.filter(x => x.email === e && x.channel === 'call').length, cv = centreActs.filter(x => x.email === e && x.channel === 'visit').length;
      return `${n}: ${lc + cc} calls (${lc} lead, ${cc} centre) · ${lv + cv} visits (${lv} lead, ${cv} centre) · ${leadsCreated.filter(l => l.email === e).length} leads created`;
    });
    const un = events.filter(x => !known.has(x.email));
    const fmt = d => d.toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' });
    return text(`WFP Performance ${fmt(F)} to ${fmt(new Date(T.getTime() - 1))}\n${lines.join('\n')}\nUnattributed (no partner identifiable): ${un.filter(x => x.channel === 'call').length} calls, ${un.filter(x => x.channel === 'visit').length} visits\nCentre calls/visits at existing clients are only counted when logged, and logging has been low.`);
  });

  server.registerTool('get_call_insights', {
    title: 'Call Analysis and Insights',
    description: 'Industry insights pulled from Workforce Partner voice notes (bottom of WFP Performance): competitor agencies and pricing, centre needs, objections and opportunities, each with the centre, partner and date. Use search_voice_notes for full transcripts.',
    inputSchema: { category: z.enum(['competitor_pricing', 'competitors', 'centre_needs', 'objections', 'opportunities', 'other']).optional() }
  }, async ({ category }) => {
    const d = await require('../services/voiceInsightsService').listInsights();
    const groups = {};
    d.recordings.forEach(r => r.insights.forEach(i => { if (!category || i.category === category) (groups[i.category] = groups[i.category] || []).push(`  - ${i.agency && !i.point.toLowerCase().includes(String(i.agency).toLowerCase()) ? i.agency + ': ' : ''}${i.point} (${[r.centre_name, r.state].filter(Boolean).join(', ')}; ${(r.uploaded_by_name || '').split(' ')[0]}, ${day(r.created_at)})`); }));
    const body = Object.entries(groups).map(([k, v]) => `${d.categories[k]} (${v.length}):\n${v.join('\n')}`).join('\n\n');
    return text(body || 'No insights yet.');
  });

  // ── General read access to HeartBeat data (Joy, 2026-10-15) ───────────
  // One tool over HeartBeat's own tables so Liam can look up anything the app
  // holds. Only the datasets listed in DATASETS are reachable. Columns that
  // hold credentials, bank account numbers or file-storage internals are
  // never returned.
  const DATASETS = {
    tasks: { table: 'tasks', date: 'created_at', about: 'All tasks across departments (title, status, priority, assignees, due date, linked educators/centres)' },
    task_notes: { table: 'task_notes', date: 'created_at', about: 'Comments on tasks (filter with equals {"task_id": "..."})' },
    task_departments: { table: 'task_departments', about: 'Task departments' },
    task_classifications: { table: 'task_classifications', about: 'Task classifications per department' },
    timesheets: { table: 'timesheet_weeks', date: 'week_start_date', about: 'Team timesheet weeks (hours, status, approvals)' },
    timesheet_entries: { table: 'timesheet_entries', date: 'entry_date', about: 'Daily timesheet entries (filter equals {"week_id": "..."} or {"user_email": "..."})' },
    payslips: { table: 'payslips', date: 'pay_period_start', about: 'Team payslips (period, days worked, line items, totals in AUD/PHP)' },
    payroll_profiles: { table: 'employee_payroll_profiles', about: 'Team pay rates (hourly, fortnightly, overtime)' },
    leave_requests: { table: 'leave_requests', date: 'start_date', about: 'Team leave requests and approvals' },
    team: { table: 'team_members', about: 'Team directory: position, team, manager, start date, contact details, equipment' },
    users: { table: 'users', about: 'HeartBeat user accounts (name, email, role, active, partner label)' },
    projects: { table: 'projects', date: 'created_at', about: 'Projects' },
    project_milestones: { table: 'project_milestones', about: 'Project milestones (filter equals {"project_id": "..."})' },
    announcements: { table: 'announcements', date: 'created_at', about: 'Team announcements' },
    articles: { table: 'articles', date: 'created_at', about: 'Knowledge base articles and SOPs' },
    faqs: { table: 'faqs', about: 'FAQs', where: "source IS DISTINCT FROM 'fathom'" },
    glossary: { table: 'glossary', about: 'Glossary terms' },
    ideas: { table: 'ideas', date: 'created_at', about: 'Team ideas' },
    article_feedback: { table: 'feedback', date: 'created_at', about: 'Suggested changes to articles' },
    call_evaluations: { table: 'call_evaluations', date: 'call_date', about: 'Call quality grades per consultant call (scores, outcome, summary, reviewer feedback)' },
    call_recordings: { table: 'call_recordings', date: 'start_time_iso', about: 'Dubber call recordings metadata and transcripts (rep, numbers, duration, sentiment)' },
    webex_calls: { table: 'webex_cdrs', date: 'start_time', about: 'Webex call history (who, direction, answered, duration, numbers)' },
    webex_agent_status: { table: 'webex_agent_status_history', date: 'started_at', about: 'Webex agent status history (available, busy, etc.)' },
    centre_visits: { table: 'centre_visits', date: 'visit_date', about: 'Logged centre calls and visits by Workforce Partners' },
    centre_partner_assignments: { table: 'centre_partner_assignments', about: 'Which Workforce Partner owns which centre' },
    hidden_centres: { table: 'hidden_centres', about: 'Centres hidden from lists' },
    planned_routes: { table: 'wfp_planned_routes', date: 'route_date', about: 'Workforce Partner planned visit routes' },
    lead_activities: { table: 'lead_activities', date: 'created_at', about: 'Logged calls/visits on leads' },
    lead_notes: { table: 'lead_notes', date: 'created_at', about: 'Notes on leads' },
    lead_educators: { table: 'lead_educators', date: 'created_at', about: 'Educators tagged to leads' },
    qr_referrals: { table: 'qr_referrals', date: 'created_at', about: 'QR code poster registrations' },
    first_booking_free: { table: 'first_booking_free_offers', date: 'offered_at', about: 'Leads/centres offered "first booking free" (who offered, email status, first booking received)' },
    first_shift_followups: { table: 'first_shift_followups', date: 'created_at', about: 'First shift follow-up calls' },
    document_checks: { table: 'document_checks', date: 'created_at', about: 'Educator document checks (First Aid/CPR etc.)' },
    training_courses: { table: 'training_courses', about: 'Training courses' },
    training_assignments: { table: 'training_assignments', about: 'Who is assigned which training' },
    training_attempts: { table: 'training_attempts', about: 'Training attempts and scores' },
    jobadder_reviews: { table: 'jobadder_application_reviews', date: 'created_at', about: 'Reviews of JobAdder applicants' },
    acecqa_qualifications: { table: 'acecqa_approved_qualifications', about: 'ACECQA approved qualifications list' },
    leads: { table: 'leads', date: 'created_at', about: 'All sales leads/centres in the Workforce Partner pipeline (every field: stage dates, partner, group category, contact details)' },
    lead_recordings: { table: 'lead_recordings', date: 'created_at', about: 'Voice notes recorded against leads (transcript and summary)' },
    lead_calendar_events: { table: 'lead_calendar_events', date: 'created_at', about: 'Calendar meetings linked to leads' },
    lead_washes: { table: 'lead_washes', date: 'created_at', about: 'Lead Wash reviews (lead quality checks)' },
    centre_recordings: { table: 'centre_recordings', date: 'created_at', about: 'Voice notes recorded against centres' },
    centre_categories: { table: 'centre_categories', about: 'Centre group category (big group, medium, small, independent, community, council)' },
    centre_educator_relationships: { table: 'centre_educator_relationships', about: 'Educators a centre has favourited or blocked' },
    dormant_touchpoints: { table: 'dormant_touchpoints', date: 'created_at', about: 'Contact made with dormant centres' },
    educator_outreach_lists: { table: 'educator_outreach_lists', date: 'created_at', about: 'Saved educator outreach lists' },
    educator_outreach_list_members: { table: 'educator_outreach_list_members', about: 'Educators on each outreach list (filter equals {"list_id": "..."})' },
    available_educator_sends: { table: 'available_educator_sends', date: 'created_at', about: 'Weekly available-educator emails sent to centres' },
    compliance_snapshots: { table: 'compliance_snapshots', date: 'created_at', about: 'Nightly educator compliance snapshots' },
    compliance_changes: { table: 'compliance_change_log', date: 'created_at', about: 'Overnight changes to educator compliance' },
    vevo_checks: { table: 'vevo_checks', date: 'created_at', about: 'VEVO visa work-rights checks' },
    signed_contracts: { table: 'signed_contracts', date: 'created_at', about: 'Centre contracts sent and signed' },
    signed_contract_events: { table: 'signed_contract_events', date: 'created_at', about: 'Contract signing events (sent, viewed, signed)' },
    consultant_calls: { table: 'consultant_calls', date: 'created_at', about: 'Consultant call logs' },
    wfp_reports: { table: 'wfp_reports', date: 'created_at', about: 'Weekly/monthly Workforce Partner reports' },
    meetings: { table: 'fathom_meetings', date: 'created_at', about: 'Recorded meetings (Fathom): title, date, summary' },
    task_link_history: { table: 'task_link_history', date: 'created_at', about: 'Changes to educators/centres linked on tasks' },
    qr_referral_attempts: { table: 'qr_referral_attempts', date: 'created_at', about: 'QR form submission attempts (saved or refused, and why)' },
    rt_data_alerts: { table: 'rt_field_alerts', date: 'created_at', about: 'Alerts when RT stops or starts sending a data field' },
    educator_status_customerio: { table: 'cio_educator_status', about: 'Educator status as held in Customer.io' }
  };
  const HIDDEN_COLUMN = /password|hash|token|secret|google_id|bank_account_number|swift|storage_path|^raw$|audio|photo_storage/i;
  const colCache = new Map();
  async function columnsFor(table) {
    if (!colCache.has(table)) {
      const rows = (await getDb().execute({ sql: 'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position', args: [table] })).rows;
      colCache.set(table, rows.filter(r => !HIDDEN_COLUMN.test(r.column_name)));
    }
    return colCache.get(table);
  }

  server.registerTool('query_heartbeat_data', {
    title: 'Query HeartBeat Data',
    description: 'Read any HeartBeat dataset. Datasets: ' + Object.entries(DATASETS).map(([k, v]) => `${k} — ${v.about}`).join('; ') + '. Use "list_fields": true to see a dataset\'s fields first. Filters: from/to (YYYY-MM-DD, on the dataset\'s main date), search (text match across text fields), equals (exact field match, e.g. {"status":"to_do"}). Newest first, up to 100 rows.',
    inputSchema: {
      dataset: z.enum(Object.keys(DATASETS)),
      list_fields: z.boolean().optional(),
      from: z.string().optional(), to: z.string().optional(),
      search: z.string().optional(),
      equals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      limit: z.number().int().min(1).max(100).optional()
    }
  }, async ({ dataset, list_fields, from, to, search, equals, limit }) => {
    const ds = DATASETS[dataset];
    const cols = await columnsFor(ds.table);
    if (!cols.length) return text('No data available for that dataset.');
    if (list_fields) return text(`${dataset} fields: ` + cols.map(c => `${c.column_name} (${c.data_type})`).join(', '));
    const names = new Set(cols.map(c => c.column_name));
    const where = ds.where ? [ds.where] : [], args = [];
    if (ds.date && names.has(ds.date)) {
      if (isDay(from)) { where.push(`${ds.date} >= CAST(? AS date)`); args.push(from); }
      if (isDay(to)) { where.push(`${ds.date} < CAST(? AS date)`); args.push(to); }
    }
    for (const [k, v] of Object.entries(equals || {})) {
      if (!names.has(k)) return text(`Unknown field "${k}" for ${dataset}. Use list_fields to see the fields.`);
      where.push(`CAST(${k} AS text) = ?`); args.push(String(v));
    }
    if (search) {
      const textCols = cols.filter(c => /text|character|json/i.test(c.data_type)).map(c => `CAST(${c.column_name} AS text)`);
      if (textCols.length) { where.push('(' + textCols.map(c => `${c} ILIKE ?`).join(' OR ') + ')'); textCols.forEach(() => args.push(`%${search}%`)); }
    }
    const order = ds.date && names.has(ds.date) ? `${ds.date} DESC NULLS LAST` : (names.has('created_at') ? 'created_at DESC' : '1');
    const rows = (await getDb().execute({
      sql: `SELECT ${cols.map(c => c.column_name).join(', ')} FROM ${ds.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`,
      args: [...args, limit || 25]
    })).rows;
    if (!rows.length) return text(`No ${dataset} rows matched.`);
    const clip = v => { const s = typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : String(v); return s.length > 600 ? s.slice(0, 600) + '…' : s; };
    return text(`${rows.length} ${dataset} row(s):\n` + rows.map(r => Object.entries(r).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k}: ${clip(v)}`).join(' | ')).join('\n'));
  });

  // ── QR code recruitment report ──────────────────────────────────────
  server.registerTool('get_qr_recruitment_report', {
    title: 'QR Code Recruitment Report',
    description: 'Educators recruited through the QR code posters in centres: registered, in RT, active (completion rate), first shift accepted, welcome bonuses triggered and Workforce Partner follow-ups, in total and by centre scanned. Optional registration date range (YYYY-MM-DD, "to" exclusive).',
    inputSchema: { from: z.string().optional(), to: z.string().optional() }
  }, async ({ from, to }) => {
    const d = await require('./qrReferrals').buildReport(from, to);
    const t = d.total;
    const line = (n, x) => `${n}: ${x.registered} registered · ${x.inRt} in RT · ${x.active} active · ${x.firstShift} first shift · ${x.bonusTriggered} bonuses · ${x.followUpsDone}/${x.followUpsCreated} follow-ups done`;
    return text([line('All centres', t), ...d.byCentre.map(c => line(c.centre, c))].join('\n') + (t.registered ? '' : '\n(No QR registrations yet.)'));
  });

  // ── Voice notes / visit transcripts ──────────────────────────────────
  server.registerTool('search_voice_notes', {
    title: 'Voice Notes & Visit Transcripts',
    description: 'Workforce Partner voice notes recorded on centre visits/calls, with full transcripts, summaries and extracted insights (competitor agencies, pricing, objections, opportunities). Optional text search across transcripts, partner name, state and date range (YYYY-MM-DD).',
    inputSchema: {
      query: z.string().optional(), partner: z.string().optional(), state: z.string().optional(),
      from: z.string().optional(), to: z.string().optional(), limit: z.number().int().min(1).max(30).optional()
    }
  }, async ({ query, partner, state, from, to, limit }) => {
    const where = ['r.transcript IS NOT NULL']; const args = [];
    if (query) { where.push('(r.transcript ILIKE ? OR l.centre_name ILIKE ?)'); args.push(`%${query}%`, `%${query}%`); }
    if (partner) { where.push('(r.uploaded_by_name ILIKE ? OR r.uploaded_by_email ILIKE ?)'); args.push(`%${partner}%`, `%${partner}%`); }
    if (state) { where.push('upper(l.state) = ?'); args.push(state.toUpperCase()); }
    if (isDay(from)) { where.push('r.created_at >= CAST(? AS date)'); args.push(from); }
    if (isDay(to)) { where.push('r.created_at < CAST(? AS date)'); args.push(to); }
    const rows = (await getDb().execute({
      sql: `SELECT r.created_at, r.uploaded_by_name, r.summary, r.transcript, r.insights, l.centre_name, l.suburb, l.state
            FROM lead_recordings r JOIN leads l ON l.id = r.lead_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`,
      args: [...args, limit || 10]
    })).rows;
    if (!rows.length) return text('No voice notes matched.');
    return text(rows.map(r => [
      `■ ${r.centre_name} (${[r.suburb, r.state].filter(Boolean).join(', ')}) — ${r.uploaded_by_name || ''}, ${day(r.created_at)}`,
      r.summary ? `Summary: ${r.summary}` : null,
      Array.isArray(r.insights) && r.insights.length ? 'Insights:\n' + r.insights.map(i => `  - ${i.point}`).join('\n') : null,
      `Transcript: ${r.transcript}`
    ].filter(Boolean).join('\n')).join('\n\n'));
  });
  // No meetings tool: Fathom content must never be reachable through MCP (Joy 16 Oct).
}

module.exports = { registerAdminTools };
