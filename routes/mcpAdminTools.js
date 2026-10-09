// Read-only admin tools for HeartBeat's MCP server — leads and the WFP
// pipeline, bookings and fill rate, JobAdder, and meeting search. Added
// 2026-10-09 so the company owner (Liam) can ask about the admin side from
// his own AI client. Everything here only reads: no tool changes data in
// HeartBeat, RT Portal or JobAdder. Payroll, payslips and timesheets are
// deliberately NOT exposed. Only accounts that pass mcpTokenService.canUseMcp
// ever reach this file (see requireMcpToken in routes/mcp.js).
const { z } = require('zod');
const { getDb } = require('../db/database');
const jobAdderService = require('../services/jobAdderService');
const fathomService = require('../services/fathomService');
const { getCentresAndBookings, computeFillRateByPartner } = require('./centres');

const STATUS_NAMES = { 1: 'Open', 2: 'Requested', 3: 'Assigned', 5: 'Completed', 6: 'Cancelled', 7: 'Failed/Unfilled' };
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
    const acts = (await db.execute({ sql: 'SELECT channel, contact_name, outcome, notes, next_step, created_by_name, created_at FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 15', args: [id] })).rows;
    const lines = [
      `${lead.centre_name} (id ${lead.id}) — ${[lead.street_address, lead.suburb, lead.state].filter(Boolean).join(', ')}`,
      `Contact: ${[lead.contact_first_name, lead.contact_last_name].filter(Boolean).join(' ') || '—'}${lead.centre_phone ? ' · ' + lead.centre_phone : ''}${lead.contact_email ? ' · ' + lead.contact_email : ''}`,
      `Submitted by ${lead.submitted_by_name || lead.submitted_by_email} on ${day(lead.created_at)} · assigned partner: ${lead.assigned_workforce_partner || 'unassigned'} · type: ${lead.entry_type}`,
      `Stages — called: ${lead.lead_called_status} ${day(lead.lead_called_at)} · visited: ${lead.centre_visited_status} ${day(lead.centre_visited_at)} · signed: ${lead.signed_status} ${day(lead.signed_at)}`,
      `Notes (${notes.length}):`, ...notes.map(n => `  - ${day(n.created_at)} ${n.author_name || ''}: ${n.note}`),
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

  server.registerTool('search_bookings', {
    title: 'Search Bookings',
    description: 'Look up RT bookings. Filter by centreKey (from search_centres), status (open, requested, assigned, completed, cancelled) and a shift-date range (YYYY-MM-DD, "to" exclusive). Returns up to 50, newest first.',
    inputSchema: {
      centreKey: z.string().optional(),
      status: z.enum(['open', 'requested', 'assigned', 'completed', 'cancelled']).optional(),
      from: z.string().optional(), to: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional()
    }
  }, async ({ centreKey, status, from, to, limit }) => {
    const { bookings, centres } = await getCentresAndBookings();
    const wanted = status ? { open: 1, requested: 2, assigned: 3, completed: 5, cancelled: 6 }[status] : null;
    const nameByKey = new Map(centres.map(c => [c.centreKey, c.name]));
    const rows = bookings.filter(b => {
      const d = (b.bookingDate || '').slice(0, 10);
      if (isDay(from) && d < from) return false;
      if (isDay(to) && d >= to) return false;
      if (wanted && b.statusId !== wanted) return false;
      if (centreKey) { const k = `loc:${b.locationId}`; if (k !== centreKey && `client:${b.clientId}` !== centreKey) return false; }
      return true;
    }).sort((a, b) => String(b.bookingDate).localeCompare(String(a.bookingDate))).slice(0, limit || 20);
    if (!rows.length) return text('No bookings matched.');
    return text(rows.map(b => `• ${(b.bookingDate || '').slice(0, 10)} · ${nameByKey.get(`loc:${b.locationId}`) || nameByKey.get(`client:${b.clientId}`) || `centre ${b.locationId || b.clientId}`} · ${STATUS_NAMES[b.statusId] || 'status ' + b.statusId}${b.assignedCandidateName ? ' · ' + b.assignedCandidateName : ''} (booking ${b.clientBookingId})`).join('\n'));
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

  // ── Meetings ──────────────────────────────────────────────────────────
  server.registerTool('search_meetings', {
    title: 'Search Meetings',
    description: 'Search recorded team meetings (Fathom) by topic. Returns title, date, link and the meeting summary / action items where available.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(10).optional() }
  }, async ({ query, limit }) => {
    const hits = await fathomService.searchMeetings(query, limit || 5);
    if (!hits.length) return text(`No meetings matched "${query}".`);
    const ids = hits.map(h => h.recording_id);
    const sums = (await getDb().execute({ sql: 'SELECT recording_id, default_summary, action_items FROM fathom_meetings WHERE recording_id = ANY(?)', args: [ids] })).rows;
    const byId = new Map(sums.map(s => [String(s.recording_id), s]));
    return text(hits.map(h => {
      const s = byId.get(String(h.recording_id)) || {};
      const summary = (s.default_summary || '').toString().slice(0, 700);
      return `• ${h.title || 'Meeting'} — ${day(h.recording_start_time || h.fathom_created_at)}${h.share_url ? '\n  ' + h.share_url : ''}${summary ? '\n  Summary: ' + summary : ''}`;
    }).join('\n\n'));
  });
}

module.exports = { registerAdminTools };
