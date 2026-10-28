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

const WASH_CUTOFF = '2026-10-29';
const OPTIONS = {
  reached: { yes: 'Yes', no_answer: 'No answer', wrong_number: 'Wrong number' },
  uses_agency: { yes: 'Yes', no: 'No', not_18_months: 'Not in 18+ months' },
  knows_referrer: { yes: 'Yes', no: 'No' },
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
// "Justine"/"Gwen", consultants their first name, the ClickUp/legacy import "Imported".
function addedByLabel(email, name) {
  const e = String(email || '').toLowerCase();
  if (!e && !name) return '—';
  if (e.startsWith('legacy-import') || /legacy import|clickup/i.test(name || '')) return 'Imported';
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

async function queue({ state, service, group, status = 'unwashed', bigFirst = true, addedBy = null } = {}) {
  const db = getDb();
  const leads = (await db.execute({
    sql: `SELECT id, centre_name, street_address, suburb, state, centre_phone, contact_first_name, contact_last_name, contact_email, position,
                 educator_name, agency_usage, submitted_by_name, submitted_by_email, created_at, lead_called_status, centre_visited_status,
                 service_type, group_category, archived_at, archived_reason, closed_at
          FROM leads WHERE created_at < CAST(? AS date) AND closed_at IS NULL`, args: [WASH_CUTOFF]
  })).rows;
  const washes = await latestWashes();
  const edLinks = await educatorLinks(leads);
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
    addedByCounts[who] = (addedByCounts[who] || 0) + 1;
    if (addedBy && who !== addedBy) continue;
    if (state && state !== 'ALL' && String(l.state || '').toUpperCase() !== state) continue;
    if (service && l.service_type !== service) continue;
    if (group && (l.group_category || 'unknown') !== group) continue;
    if (status === 'unwashed' && !(st === 'unwashed' || st === 'attempted')) continue;
    if (status && !['unwashed', 'all'].includes(status) && st !== status) continue;
    out.push({
      id: l.id, centreName: l.centre_name, address: [l.street_address, l.suburb, l.state].filter(Boolean).join(', '), state: l.state,
      phone: l.centre_phone, contact: [l.contact_first_name, l.contact_last_name].filter(x => x && !/not provided/i.test(x)).join(' ') || null,
      contactEmail: l.contact_email, position: l.position, educatorName: l.educator_name, agencyUsage: l.agency_usage,
      educator: edLinks.get(l.id) || null, addedBy: who,
      submittedBy: l.submitted_by_name, createdAt: l.created_at, wfpContacted: l.lead_called_status === 'done' || l.centre_visited_status === 'done',
      serviceType: l.service_type, groupCategory: l.group_category, categoryLabel: category.label(l.service_type, l.group_category),
      washStatus: st, lastWash: w ? { at: w.washed_at, by: w.washed_by_name, reached: w.reached, verdict: w.verdict, reason: w.not_viable_reason } : null
    });
  }
  out.sort((a, b) => (bigFirst ? (GROUP_RANK[a.groupCategory || 'unknown'] - GROUP_RANK[b.groupCategory || 'unknown']) : 0)
    || String(a.state || '').localeCompare(String(b.state || '')) || new Date(a.createdAt) - new Date(b.createdAt));
  return { tally, leads: out, options: OPTIONS, cutoff: WASH_CUTOFF, addedByOptions: Object.entries(addedByCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ name: k, count: n })) };
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
  const row = (await db.execute({
    sql: `INSERT INTO lead_washes (lead_id, reached, uses_agency, dm_name, dm_role, dm_phone, dm_email, knows_referrer, verdict, not_viable_reason, notes, washed_by_email, washed_by_name)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [leadId, reached, pick('uses_agency', body.usesAgency), s(body.dmName), s(body.dmRole), s(body.dmPhone), s(body.dmEmail), pick('knows_referrer', body.knowsReferrer),
      verdict, verdict === 'not_viable' ? reason : null, s(body.notes), user.email, user.name || user.email]
  })).rows[0];
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

module.exports = { WASH_CUTOFF, OPTIONS, canWash, queue, history, recordWash };
