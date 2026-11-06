// Lead Wash (Liam, 26 Oct 2026): consultants re-call every existing lead "as if
// it were brand new" to end up with a smaller, solid list (his example 500 →
// 280). Scope = leads that existed when the wash started (WASH_CUTOFF) and
// aren't closed. New leads after that stay with the Workforce Partners until a
// WFP has called or visited them (leadFunnelService "New (WFP only)").
// Each attempt is a row in lead_washes; the newest row is the lead's result.
// NOT VIABLE archives the lead with the reason, never deletes it. Washing never
// changes lead_called_status (that's the WFP's call).
const { getDb } = require('../db/database');
const category = require('./leadCategoryService');
const { suggestGroup } = require('./groupSuggestions');

const WASH_CUTOFF = '2026-10-29';
const OPTIONS = {
  reached: { yes: 'Yes', no_answer: 'No answer', wrong_number: 'Wrong number' },
  uses_agency: { yes: 'Yes', no: 'No', not_18_months: 'Not in 18+ months' },
  knows_referrer: { yes: 'Yes', no: 'No', favourite: 'Favourite' },
  verdict: { solid: 'SOLID (keep)', not_viable: 'NOT VIABLE' },
  not_viable_reason: { no_agency: 'No agency use', closed: 'Closed', duplicate: 'Duplicate', wrong_details: 'Wrong details', not_interested: 'Not interested' }
};
const GROUP_RANK = { big: 0, medium: 1, small: 2, community: 3, council: 4, independent: 5, unknown: 6 };

// Joy, 28 Oct: "don't let that be visible to consultants yet". Lead Wash and the
// Call List are limited to Joy (super_admin), Sophia and Liam for now.
// can_wash_leads stays in the schema but is ignored until Joy opens it up.
const PREVIEW_EMAILS = ['sophia@rawtalent.com.au', 'liam@rawtalent.com.au'];
function canWash(user) {
  return !!user && (user.role === 'super_admin' || PREVIEW_EMAILS.includes(String(user.email || '').toLowerCase()));
}

async function latestWashes() {
  const rows = (await getDb().execute({ sql: 'SELECT DISTINCT ON (lead_id) * FROM lead_washes ORDER BY lead_id, washed_at DESC', args: [] })).rows;
  return new Map(rows.map(r => [r.lead_id, r]));
}

// "Added by" as a first name (Joy, 29 Oct): Workforce Partners are just
// "Justine"/"Gwen", consultants their first name, the ClickUp/legacy import "From ClickUp".
// Legacy ClickUp imports (Joy, 29 Oct): "From ClickUp", no name.
function addedByLabel(email, name) {
  const e = String(email || '').toLowerCase();
  if (!e && !name) return '—';
  if (e.startsWith('legacy-import') || /legacy import|clickup/i.test(name || '')) return 'From ClickUp';
  if (e === 'justine@rawtalent.com.au') return 'Justine';
  if (e === 'gwen@rawtalent.com.au') return 'Gwen';
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || (e ? e.split('@')[0].replace(/^./, c => c.toUpperCase()) : '—');
}

// Linked educator: a lead_educators link if there is one, otherwise the typed
// educator_name, linked to their RT profile when exactly one RT educator has that name.
async function educatorLinks(leads) {
  const db = getDb();
  const ids = leads.map(l => l.id);
  const linked = ids.length ? (await db.execute({ sql: 'SELECT DISTINCT ON (lead_id) lead_id, candidate_user_id FROM lead_educators WHERE lead_id = ANY(?) ORDER BY lead_id, created_at', args: [ids] })).rows : [];
  const linkBy = new Map(linked.map(r => [r.lead_id, String(r.candidate_user_id)]));
  const names = [...new Set(leads.map(l => String(l.educator_name || '').trim().toLowerCase()).filter(n => n.split(/\s+/).length >= 2))];
  const rows = names.length ? (await db.execute({
    sql: `SELECT user_id::text uid, lower(trim(first_name || ' ' || last_name)) full_name, first_name, last_name FROM rt_candidates_cache
          WHERE is_deleted IS NOT TRUE AND lower(trim(first_name || ' ' || last_name)) = ANY(?)`, args: [names]
  })).rows : [];
  const byName = {};
  rows.forEach(r => { (byName[r.full_name] = byName[r.full_name] || []).push(r); });
  const linkedIds = [...new Set([...linkBy.values()])];
  const linkedRows = linkedIds.length ? (await db.execute({ sql: 'SELECT user_id::text uid, first_name, last_name FROM rt_candidates_cache WHERE user_id::text = ANY(?)', args: [linkedIds] })).rows : [];
  const linkedName = new Map(linkedRows.map(r => [r.uid, `${r.first_name || ''} ${r.last_name || ''}`.trim()]));
  const out = new Map();
  for (const l of leads) {
    const uid = linkBy.get(l.id);
    if (uid) { out.set(l.id, { name: linkedName.get(uid) || l.educator_name || `Educator ${uid}`, rtUserId: uid }); continue; }
    const n = String(l.educator_name || '').trim();
    if (!n) continue;
    const hits = byName[n.toLowerCase()] || [];
    out.set(l.id, { name: n, rtUserId: hits.length === 1 ? hits[0].uid : null });
  }
  return out;
}

// Educator first (Joy, 3 Nov): a short RT summary of each linked educator so
// consultants can check the educator before calling the centres they named.
const RT_STATUS_LABELS = { 0: 'Vetting Call', 1: 'Active', 2: 'In Progress', 4: 'Do Not Use', 5: 'Awaiting Activation', 8: 'Not Interested', 9: 'Student', 10: 'Pending Reference' };

async function saveEducatorNotes(key, notes, user) {
  if (!/^(rt|name):.{1,200}$/.test(String(key || ''))) throw Object.assign(new Error('Invalid educator'), { status: 400 });
  const text = String(notes == null ? '' : notes).slice(0, 10000);
  await getDb().execute({
    sql: `INSERT INTO lead_wash_educator_notes (educator_key, notes, updated_by_email, updated_by_name, updated_at) VALUES (?, ?, ?, ?, now())
          ON CONFLICT (educator_key) DO UPDATE SET notes = EXCLUDED.notes, updated_by_email = EXCLUDED.updated_by_email, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
    args: [key, text, user.email || null, user.name || null]
  });
  return { ok: true };
}

// Lead Wash pipeline (Liam, 6 Nov 2026): consultants confirm with the educator first,
// then the Workforce Partner does the reference call, books a visit, and decides.
const STAGES = [
  { key: 'new', label: 'New', color: '#fee2e2', text: '#b91c1c' },
  { key: 'educator_confirmed', label: 'Educator confirmed', color: '#fef3c7', text: '#b45309' },
  { key: 'centre_called', label: 'Reference / centre called', color: '#dbeafe', text: '#1d4ed8' },
  { key: 'visit_booked', label: 'Visit booked', color: '#ccfbf1', text: '#0f766e' },
  { key: 'solid', label: 'Solid', color: '#dcfce7', text: '#15803d' },
  { key: 'not_viable', label: 'Not viable', color: '#f1f5f9', text: '#475569' }
];
const CHECK_FIELDS = { workedHere: 'worked_here', lastShift: 'last_shift', howOften: 'how_often', agencyUsed: 'agency_used', otherAgencyEducators: 'other_agency_educators', favourite: 'favourite', managerName: 'manager_name', notes: 'notes' };

async function saveEducatorCheck(leadId, body, user) {
  const db = getDb();
  const lead = (await db.execute({ sql: 'SELECT id FROM leads WHERE id = ? AND closed_at IS NULL', args: [leadId] })).rows[0];
  if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
  const v = k => { const x = body[k]; return x == null || x === '' ? null : String(x).trim().slice(0, 500); };
  if (v('workedHere') && !['yes', 'no'].includes(v('workedHere'))) throw Object.assign(new Error('Did they work here: yes or no'), { status: 400 });
  const cols = Object.values(CHECK_FIELDS), vals = Object.keys(CHECK_FIELDS).map(v);
  await db.execute({
    sql: `INSERT INTO lead_wash_educator_checks (lead_id, ${cols.join(', ')}, updated_by_email, updated_by_name, updated_at)
          VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, now())
          ON CONFLICT (lead_id) DO UPDATE SET ${cols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}, updated_by_email = EXCLUDED.updated_by_email, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
    args: [leadId, ...vals, user.email || null, user.name || null]
  });
  if (body.agencyUsage && ['target_temp', 'high_agency_user'].includes(body.agencyUsage)) {
    await db.execute({ sql: 'UPDATE leads SET agency_usage = ?, updated_at = now() WHERE id = ?', args: [body.agencyUsage, leadId] });
  }
  // The educator never worked there: the lead isn't real, so it leaves the wash (archived, not deleted).
  if (v('workedHere') === 'no') {
    await db.execute({ sql: "UPDATE leads SET archived_at = now(), archived_reason = 'Lead wash: educator says they never worked here', updated_at = now() WHERE id = ? AND archived_at IS NULL", args: [leadId] });
  }
  return { ok: true };
}

// A centre the educator mentioned on the call: created through the normal New Lead form,
// then flagged so it shows in Lead Wash and linked to the educator.
async function adoptLead(leadId, body, user) {
  const db = getDb();
  await db.execute({ sql: 'UPDATE leads SET wash_added = true WHERE id = ?', args: [leadId] });
  if (body.rtUserId && /^\d+$/.test(String(body.rtUserId))) {
    await db.execute({ sql: 'INSERT INTO lead_educators (id, lead_id, candidate_user_id, note, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (lead_id, candidate_user_id) DO NOTHING',
      args: [require('crypto').randomUUID(), leadId, String(body.rtUserId), 'Named on the Lead Wash call', user.email || null, user.name || null] });
  }
  return { ok: true };
}

// Book the Workforce Partner's visit straight from the wash (shows as Visit scheduled in Leads / Today).
async function bookVisit(leadId, body, user) {
  const when = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(when)) throw Object.assign(new Error('Pick a date for the visit'), { status: 400 });
  const db = getDb();
  await db.execute({ sql: "UPDATE leads SET centre_visited_status = 'scheduled', centre_visited_at = ?, updated_at = now() WHERE id = ?", args: [when.length === 10 ? when + 'T09:00:00' : when + ':00', leadId] });
  await db.execute({ sql: 'INSERT INTO lead_notes (id, lead_id, note, author_name, author_email) VALUES (?, ?, ?, ?, ?)',
    args: [require('crypto').randomUUID(), leadId, `Lead Wash: visit booked for ${when.slice(0, 10).split('-').reverse().join('/')}.`, user.name || user.email, user.email] });
  return { ok: true };
}

// RT Portal's Reference Form, question for question (backoffice Reference/SubmitReference).
const REFERENCE_FORM = [
  { k: 'fromMonth', q: 'From month', t: 'text' }, { k: 'fromYear', q: 'From year', t: 'text' },
  { k: 'toMonth', q: 'To month', t: 'text' }, { k: 'toYear', q: 'To year', t: 'text' },
  { k: 'capacity', q: 'In what capacity do you know the above-mentioned applicant?', t: 'textarea' },
  { k: 'position', q: "What was the applicant's position within your organisation?", t: 'text' },
  { k: 'observed', q: 'Have you observed this applicant working with children?', t: 'yesno' },
  { k: 'concernChildren', q: 'Did you have any concerns about their behaviour or conduct when working with children?', t: 'yesno' },
  { k: 'concernTeam', q: "Did you have any concerns about the applicant's professionalism, attitude, or ability to work within a team?", t: 'yesno' },
  { k: 'disciplinary', q: 'Has any disciplinary action been taken against the applicant in relation to inappropriate or unprofessional conduct toward a child?', t: 'yesno' },
  { k: 'engagement', q: 'Engagement with children', t: 'rating' },
  { k: 'initiative', q: 'Demonstration of initiative', t: 'rating' },
  { k: 'rapport', q: 'Rapport with staff', t: 'rating' },
  { k: 'ability', q: 'Overall ability', t: 'rating' },
  { k: 'recommend', q: 'Would you recommend this person for temporary work?', t: 'yesno' },
  { k: 'reemploy', q: 'Theoretically, would you re-employ this person?', t: 'yesno' },
  { k: 'illness', q: 'To the best of your knowledge, has this candidate suffered any illness or impairment that would affect their capacity to work in early childhood?', t: 'yesno' },
  { k: 'comments', q: 'Do you have further comments you wish to provide?', t: 'textarea' },
  { k: 'refereeName', q: 'Referee name', t: 'text' }, { k: 'refereePosition', q: 'Position', t: 'text' }, { k: 'refereeCentre', q: 'Centre name', t: 'text' },
  { k: 'disclose', q: 'Do you permit us to disclose information from this reference to the applicant if requested?', t: 'yesno' }
];
const RATINGS = ['Excellent', 'Very Good', 'Good', 'Average', 'Not Acceptable'];

async function saveReference(leadId, body, user) {
  const answers = {};
  for (const f of REFERENCE_FORM) {
    let v = body.answers && body.answers[f.k];
    if (v == null || v === '') continue;
    v = String(v).trim().slice(0, 2000);
    if (f.t === 'yesno' && !['Yes', 'No'].includes(v)) throw Object.assign(new Error(`Invalid answer for ${f.q}`), { status: 400 });
    if (f.t === 'rating' && !RATINGS.includes(v)) throw Object.assign(new Error(`Invalid rating for ${f.q}`), { status: 400 });
    answers[f.k] = v;
  }
  if (!Object.keys(answers).length) throw Object.assign(new Error('Fill in at least one answer'), { status: 400 });
  const key = /^(rt|name):.{1,200}$/.test(String(body.educatorKey || '')) ? body.educatorKey : null;
  const row = (await getDb().execute({
    sql: 'INSERT INTO lead_wash_references (id, lead_id, educator_key, answers, created_by_email, created_by_name) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
    args: [require('crypto').randomUUID(), leadId, key, JSON.stringify(answers), user.email || null, user.name || null]
  })).rows[0];
  return row;
}

async function educatorSummaries(uids) {
  if (!uids.length) return {};
  const rows = (await getDb().execute({
    sql: `SELECT user_id::text uid, first_name, last_name, status, suburb, raw->>'obStatus' ob FROM rt_candidates_cache WHERE user_id::text = ANY(?)`, args: [uids]
  })).rows;
  const shifts = {};
  try {
    const { bookings } = await require('../routes/centres').getCentresAndBookings();
    const want = new Set(uids), now = Date.now();
    for (const b of bookings) {
      const k = String(b.assignedUserId || '');
      if (!want.has(k) || !b.bookingDate) continue;
      const t = new Date(b.bookingDate).getTime();
      const e = shifts[k] = shifts[k] || { done: 0, upcoming: 0, last: null };
      if (b.statusId === 5 && t <= now) { e.done++; if (!e.last || t > e.last) e.last = t; }
      else if ([1, 2, 3].includes(b.statusId) && t > now) e.upcoming++;
    }
  } catch { /* RT bookings unavailable: show the profile without shift counts */ }
  return Object.fromEntries(rows.map(r => {
    const sh = shifts[r.uid] || { done: 0, upcoming: 0, last: null };
    return [r.uid, { name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), active: r.status === 1, statusLabel: RT_STATUS_LABELS[r.status] || null, onboarding: r.ob || null, suburb: r.suburb || null,
      shiftsDone: sh.done, upcoming: sh.upcoming, lastShift: sh.last ? new Date(sh.last).toISOString().slice(0, 10) : null }];
  }));
}

async function queue({ state, service, group, status = 'unwashed', bigOnly = false, addedBy = null, stage = null } = {}) {
  const db = getDb();
  const leads = (await db.execute({
    sql: `SELECT id, centre_name, street_address, suburb, state, centre_phone, contact_first_name, contact_last_name, contact_email, position,
                 educator_name, agency_usage, submitted_by_name, submitted_by_email, created_at, lead_called_status, centre_visited_status, centre_visited_at, wash_added,
                 service_type, group_category, archived_at, archived_reason, closed_at
          FROM leads WHERE (created_at < CAST(? AS date) OR wash_added) AND closed_at IS NULL`, args: [WASH_CUTOFF]
  })).rows;
  const washes = await latestWashes();
  const edLinks = await educatorLinks(leads);
  const checks = new Map((await db.execute({ sql: 'SELECT * FROM lead_wash_educator_checks', args: [] })).rows.map(r => [r.lead_id, r]));
  const refLeadIds = new Set((await db.execute({ sql: 'SELECT DISTINCT lead_id FROM lead_wash_references', args: [] })).rows.map(r => r.lead_id));
  const stageCounts = Object.fromEntries(STAGES.map(s => [s.key, 0]));
  const addedByCounts = {};
  const tally = { inScope: 0, washed: 0, solid: 0, notViable: 0, attemptedOnly: 0, remaining: 0 };
  const out = [];
  for (const l of leads) {
    const w = washes.get(l.id) || null;
    const washedArchived = l.archived_at && w?.verdict === 'not_viable';
    if (l.archived_at && !washedArchived) continue; // archived for some other reason before the wash
    tally.inScope++;
    const st = w?.verdict === 'solid' ? 'solid' : w?.verdict === 'not_viable' ? 'not_viable' : w ? 'attempted' : 'unwashed';
    if (st === 'solid') { tally.washed++; tally.solid++; }
    else if (st === 'not_viable') { tally.washed++; tally.notViable++; }
    else { tally.remaining++; if (st === 'attempted') tally.attemptedOnly++; }
    const who = addedByLabel(l.submitted_by_email, l.submitted_by_name);
    const sug = l.group_category ? null : suggestGroup(l.centre_name);
    const effGroup = l.group_category || (sug && sug.group) || 'unknown';
    addedByCounts[who] = (addedByCounts[who] || 0) + 1;
    if (addedBy && who !== addedBy) continue;
    if (state && state !== 'ALL' && String(l.state || '').toUpperCase() !== state) continue;
    if (service && l.service_type !== service) continue;
    if (group && effGroup !== group) continue;
    if (bigOnly && effGroup !== 'big') continue;
    const chk = checks.get(l.id) || null;
    const stg = st === 'not_viable' ? 'not_viable' : st === 'solid' ? 'solid'
      : ['scheduled', 'done'].includes(l.centre_visited_status) && chk ? 'visit_booked'
      : (refLeadIds.has(l.id) || (w && w.reached === 'yes')) ? 'centre_called'
      : chk && chk.worked_here === 'yes' ? 'educator_confirmed' : 'new';
    stageCounts[stg]++;
    if (stage && stg !== stage) continue;
    if (!stage && status === 'unwashed' && !(st === 'unwashed' || st === 'attempted')) continue;
    if (!stage && status && !['unwashed', 'all'].includes(status) && st !== status) continue;
    out.push({
      id: l.id, centreName: l.centre_name, address: [l.street_address, l.suburb, l.state].filter(Boolean).join(', '), state: l.state,
      phone: l.centre_phone, contact: [l.contact_first_name, l.contact_last_name].filter(x => x && !/not provided/i.test(x)).join(' ') || null,
      contactEmail: l.contact_email, position: l.position, educatorName: l.educator_name, agencyUsage: l.agency_usage,
      educator: edLinks.get(l.id) || null, addedBy: who,
      suggestedGroup: sug, effGroup,
      submittedBy: l.submitted_by_name, createdAt: l.created_at, wfpContacted: l.lead_called_status === 'done' || l.centre_visited_status === 'done',
      serviceType: l.service_type, groupCategory: l.group_category, categoryLabel: category.label(l.service_type, l.group_category),
      stage: stg, educatorCheck: chk, visitStatus: l.centre_visited_status, visitAt: l.centre_visited_at, washAdded: !!l.wash_added,
      washStatus: st, lastWash: w ? { at: w.washed_at, by: w.washed_by_name, reached: w.reached, verdict: w.verdict, reason: w.not_viable_reason } : null
    });
  }
  // Big groups (set or suggested) always sit at the top (Joy, 29 Oct).
  out.sort((a, b) => (GROUP_RANK[a.effGroup] - GROUP_RANK[b.effGroup])
    || String(a.state || '').localeCompare(String(b.state || '')) || new Date(a.createdAt) - new Date(b.createdAt));
  const educators = await educatorSummaries([...new Set(out.map(l => l.educator && l.educator.rtUserId).filter(Boolean))]);
  const educatorNotes = Object.fromEntries((await db.execute({ sql: 'SELECT educator_key, notes, updated_by_name, updated_at FROM lead_wash_educator_notes', args: [] })).rows
    .map(r => [r.educator_key, { notes: r.notes, by: r.updated_by_name, at: r.updated_at }]));
  const refRows = out.length ? (await db.execute({ sql: 'SELECT DISTINCT ON (lead_id) lead_id, answers, created_by_name, created_at FROM lead_wash_references WHERE lead_id = ANY(?) ORDER BY lead_id, created_at DESC', args: [out.map(l => l.id)] })).rows : [];
  const references = Object.fromEntries(refRows.map(r => [r.lead_id, { answers: r.answers, by: r.created_by_name, at: r.created_at }]));
  return { tally, stageCounts, stages: STAGES, leads: out, educators, educatorNotes, references, referenceForm: REFERENCE_FORM, ratings: RATINGS, options: OPTIONS, cutoff: WASH_CUTOFF, addedByOptions: Object.entries(addedByCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ name: k, count: n })) };
}

async function history(leadId) {
  return (await getDb().execute({ sql: 'SELECT * FROM lead_washes WHERE lead_id = ? ORDER BY washed_at DESC', args: [leadId] })).rows;
}

async function recordWash(leadId, body, user) {
  const db = getDb();
  const pick = (k, v) => { if (v == null || v === '') return null; if (!OPTIONS[k][v]) throw Object.assign(new Error(`Invalid value for ${k}`), { status: 400 }); return v; };
  const reached = pick('reached', body.reached);
  if (!reached) throw Object.assign(new Error('Say whether you reached them'), { status: 400 });
  const verdict = pick('verdict', body.verdict);
  const reason = pick('not_viable_reason', body.notViableReason);
  if (verdict === 'not_viable' && !reason) throw Object.assign(new Error('Pick a reason for NOT VIABLE'), { status: 400 });
  if (reached === 'yes' && !verdict) throw Object.assign(new Error('Pick SOLID or NOT VIABLE'), { status: 400 });
  const lead = (await db.execute({ sql: 'SELECT id, archived_at FROM leads WHERE id = ? AND closed_at IS NULL', args: [leadId] })).rows[0];
  if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
  const s = v => (v == null ? null : String(v).trim().slice(0, 300) || null);
  if (s(body.dmEmail) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s(body.dmEmail))) throw Object.assign(new Error('That decision maker email doesn’t look right'), { status: 400 });
  const row = (await db.execute({
    sql: `INSERT INTO lead_washes (lead_id, reached, uses_agency, dm_name, dm_role, dm_phone, dm_email, knows_referrer, verdict, not_viable_reason, notes, washed_by_email, washed_by_name)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [leadId, reached, pick('uses_agency', body.usesAgency), s(body.dmName), s(body.dmRole), s(body.dmPhone), s(body.dmEmail), pick('knows_referrer', body.knowsReferrer),
      verdict, verdict === 'not_viable' ? reason : null, s(body.notes), user.email, user.name || user.email]
  })).rows[0];
  // The decision maker's email/name become the lead's contact when it has none:
  // Journey 1 Leads emails go to leads.contact_email (services/leadJourneyService.js).
  const dmEmail = s(body.dmEmail);
  if (dmEmail) await db.execute({ sql: "UPDATE leads SET contact_email = ?, updated_at = now() WHERE id = ? AND COALESCE(contact_email, '') = ''", args: [dmEmail, leadId] });
  const dmFirst = (s(body.dmName) || '').split(/\s+/)[0];
  if (dmFirst) await db.execute({ sql: "UPDATE leads SET contact_first_name = ? WHERE id = ? AND (COALESCE(contact_first_name, '') = '' OR contact_first_name ILIKE '%not provided%')", args: [dmFirst, leadId] });
  // A direct number from the call replaces the centre phone (Liam, 5 Nov: big groups list a
  // 1300 switchboard; the centre's own line is what we want to dial next time). The old
  // number is kept in a lead note so nothing is lost.
  const dmPhone = s(body.dmPhone);
  if (dmPhone) {
    const digits = v => String(v || '').replace(/\D/g, '').replace(/^61/, '0');
    const cur = (await db.execute({ sql: 'SELECT centre_phone FROM leads WHERE id = ?', args: [leadId] })).rows[0]?.centre_phone || '';
    if (digits(dmPhone) && digits(dmPhone) !== digits(cur)) {
      await db.execute({ sql: 'UPDATE leads SET centre_phone = ?, updated_at = now() WHERE id = ?', args: [dmPhone, leadId] });
      await db.execute({ sql: 'INSERT INTO lead_notes (id, lead_id, note, author_name, author_email) VALUES (?, ?, ?, ?, ?)',
        args: [require('crypto').randomUUID(), leadId, `Lead Wash: centre phone updated to ${dmPhone}${cur ? ` (was ${cur})` : ''}.`, user.name || user.email, user.email] });
    }
  }
  if (body.serviceType || body.groupCategory) await category.setLeadCategory(leadId, { serviceType: body.serviceType, groupCategory: body.groupCategory }, user);
  if (verdict === 'not_viable') {
    await db.execute({ sql: 'UPDATE leads SET archived_at = now(), archived_reason = ?, updated_at = now() WHERE id = ?', args: [`Lead wash: ${OPTIONS.not_viable_reason[reason]}`, leadId] });
  } else if (verdict === 'solid' && lead.archived_at) {
    // Re-washed as solid after an earlier NOT VIABLE → bring it back.
    await db.execute({ sql: "UPDATE leads SET archived_at = NULL, archived_reason = NULL, updated_at = now() WHERE id = ? AND archived_reason LIKE 'Lead wash:%'", args: [leadId] });
  }
  require('./leadFunnelService').invalidate();
  return row;
}

module.exports = { saveEducatorCheck, adoptLead, bookVisit, STAGES, saveReference, saveEducatorNotes, WASH_CUTOFF, OPTIONS, canWash, queue, history, recordWash };
