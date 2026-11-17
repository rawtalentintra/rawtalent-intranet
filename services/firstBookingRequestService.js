// "Create my first booking" requests (Liam, 16 Nov 2026, Fathom 900546391 at 14:45).
//
// Every Journey 1 email button (ECEC + OSHC, centres and leads) opens the public
// page /first-booking instead of the Portal. The centre confirms "Yes", sees
// "Thank you. Our team will be in touch shortly to support you with your first
// [free] booking.", and HeartBeat:
//   1. emails contact@rawtalent.com.au (Customer.io send API, internal only),
//   2. creates an URGENT task for Ops (Lorie, Sophia) + the centre's owner WFP with
//      the SOP: create the centre in RT if it's a lead, create the booking,
//      handpick an educator, call them to welcome,
//   3. posts in today's #daily-check-in thread tagging Ops.
// The same person clicking again within 24h is recorded once (no repeat alerts).
// Reads RT only; never writes to RT.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const INBOX = 'contact@rawtalent.com.au';
const OPS = ['lorie@rawtalent.com.au', 'sophia@rawtalent.com.au'];
// Joy gets her own copy of every alert email and is tagged on the task, with Sophia (Joy, 17 Nov).
const ALSO_EMAIL = ['joy@rawtalent.com.au'];
const TAGGED = ['joy@rawtalent.com.au', 'sophia@rawtalent.com.au'];
const CLIENT_FOLLOW_UP = '4c6ae463-b50e-43b5-934a-a81572c024e9'; // Tasks: management -> Client Follow up
const APP_URL = 'https://rawtalent-internal.app';

const esc = x => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v, n = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// Who is this? RT client (Customer.io id = RT person id, or the client's email),
// else a HeartBeat lead by contact email, else just what the link carried.
async function identify({ cioId, email }) {
  const out = { centreKey: null, centreName: null, leadId: null, ownerName: null, ownerEmail: null, contactName: null, phone: null, state: null };
  const em = String(email || '').toLowerCase();
  try {
    const { centres, rawClients } = await require('../routes/centres').getCentresAndBookings();
    const client = (rawClients || []).find(c => (cioId && String(c.primaryUserId) === String(cioId)) || (em && String(c.email || '').toLowerCase() === em));
    if (client) {
      const c = centres.find(x => String(x.rtClientId) === String(client.clientId));
      if (c) {
        Object.assign(out, { centreKey: c.centreKey, centreName: c.name, contactName: c.contactName || null, phone: c.contactNo || null, state: c.state || null });
        const { ownerFields } = require('./firstBookingFreeService');
        const f = await ownerFields(c.centreKey);
        out.ownerName = f.wfp_owner_name; out.ownerEmail = f.wfp_owner_email;
        return out;
      }
    }
  } catch (_) { /* RT down: fall through to the lead lookup */ }
  if (em) {
    const l = (await getDb().execute({ sql: `SELECT id, centre_name, contact_first_name, contact_last_name, centre_phone, state, assigned_workforce_partner
        FROM leads WHERE lower(contact_email) = ? ORDER BY created_at DESC LIMIT 1`, args: [em] })).rows[0];
    if (l) {
      const { WFP_EMAIL } = require('./firstBookingFreeService');
      Object.assign(out, { leadId: l.id, centreName: l.centre_name, contactName: [l.contact_first_name, l.contact_last_name].filter(x => x && !/not provided/i.test(x)).join(' ') || null,
        phone: l.centre_phone || null, state: l.state || null, ownerName: l.assigned_workforce_partner || null, ownerEmail: WFP_EMAIL[l.assigned_workforce_partner] || null });
    }
  }
  return out;
}

async function createRequest(input) {
  const db = getDb();
  const cioId = clean(input.cioId, 80) || null;
  const email = clean(input.email, 200).toLowerCase() || null;
  const fbf = input.fbf === true || input.fbf === '1' || input.fbf === 'true';
  const sourceEmail = clean(input.source, 60) || null;
  if (!cioId && !email) return { ok: true, recorded: false };

  const conds = [], args = [];
  if (cioId) { conds.push('cio_id = ?'); args.push(cioId); }
  if (email) { conds.push('lower(email) = ?'); args.push(email); }
  const recent = (await db.execute({ sql: `SELECT id FROM first_booking_requests WHERE (${conds.join(' OR ')}) AND created_at > now() - interval '24 hours' LIMIT 1`, args })).rows[0];
  if (recent && !String(email || '').endsWith('@rawtalent.com.au')) return { ok: true, recorded: false, duplicate: true };

  // Test mode: a Raw Talent staff address (e.g. Joy testing the emails) gets the
  // alert email + task itself; Ops, contact@ and Slack are left alone.
  const isTest = !!email && email.endsWith('@rawtalent.com.au');
  const who = await identify({ cioId, email });
  const centreName = who.centreName || clean(input.centreName, 150) || email || 'Unknown centre';
  const isLead = !who.centreKey;
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO first_booking_requests (id, cio_id, email, centre_name, centre_key, lead_id, fbf, source_email, owner_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, cioId, email, centreName, who.centreKey, who.leadId, fbf, sourceEmail, who.ownerName]
  });

  const steps = [
    isLead ? 'Create the centre in RT (they are a lead, not set up in RT yet).' : 'Centre is already set up in RT.',
    `Create their first booking${fbf ? ' (FIRST BOOKING FREE: do not charge it)' : ''}.`,
    'Handpick an educator for it.',
    'Call them to welcome them and confirm the booking.'
  ];
  const facts = [
    ['Centre', centreName], ['Contact', who.contactName], ['Email', email], ['Phone', who.phone], ['State', who.state],
    ['In RT', isLead ? (who.leadId ? 'No, HeartBeat lead' : 'Not found in RT or HeartBeat') : 'Yes'],
    ['First booking free', fbf ? 'Yes' : 'No'], ['Owner', who.ownerName], ['Clicked from', sourceEmail]
  ].filter(([, v]) => v);
  const title = `${isTest ? "[TEST] " : ""}URGENT: ${centreName} wants to create their first ${fbf ? 'free ' : ''}booking`;

  // Task for Ops + owner
  let taskId = null;
  try {
    taskId = uuidv4();
    const assignees = isTest ? [email] : [...new Set([...OPS, who.ownerEmail].filter(Boolean))];
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'management', ?, ?, ?, 'to_do', 'urgent', ?, (now() AT TIME ZONE 'Australia/Melbourne')::date, 'system@rawtalent.internal', 'Auto — First booking request', ?, '[]', ?)`,
      args: [taskId, CLIENT_FOLLOW_UP, title,
        `${centreName} clicked "Yes, create my first booking" in a Journey 1 email.\n\n` + facts.map(([k, v]) => `${k}: ${v}`).join('\n') +
        `\n\nWhat to do:\n` + steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
        JSON.stringify(assignees), JSON.stringify(isTest ? [] : TAGGED), JSON.stringify(who.centreKey ? [{ centreKey: who.centreKey, name: centreName }] : [])]
    });
    await db.execute({ sql: 'UPDATE first_booking_requests SET task_id = ? WHERE id = ?', args: [taskId, id] });
    if (!isTest) {
      try { await require('./slackService').notifyTaskTagged(taskId, assignees, 'assigned to'); } catch (_) { /* best effort */ }
      const tagOnly = TAGGED.filter(e => !assignees.includes(e));
      if (tagOnly.length) { try { await require('./slackService').notifyTaskTagged(taskId, tagOnly, 'tagged on'); } catch (_) { /* best effort */ } }
    }
  } catch (err) { console.error('First booking request task failed:', err.message); taskId = null; }

  const alerts = require('./firstBookingAlertService');
  const taskLink = taskId ? `${APP_URL}/?tab=tasks&task=${taskId}` : APP_URL;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#21275D;max-width:560px">
<p style="margin:0 0 12px"><strong>${esc(centreName)}</strong> clicked "Yes, create my first booking" in a Journey 1 email.</p>
<p style="margin:0 0 12px">${facts.map(([k, v]) => `<strong>${esc(k)}:</strong> ${esc(v)}`).join('<br>')}</p>
<p style="margin:0 0 6px"><strong>What to do:</strong></p><ol style="margin:0 0 12px;padding-left:20px">${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
<p style="margin:18px 0 12px"><a href="${taskLink}" style="display:inline-block;background:#21275D;color:#ffffff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:6px">Open the task in HeartBeat</a></p>
<p style="margin:18px 0 0;font-size:12px;color:#6b7280">Sent automatically by HeartBeat. Internal only.</p></div>`;
  const subject = `${isTest ? '[TEST] ' : ''}First booking request: ${centreName}${fbf ? ' (first booking free)' : ''}`;
  const emailStatus = await alerts.sendEmail(isTest ? email : INBOX, subject, html);
  if (!isTest) for (const cc of ALSO_EMAIL) await alerts.sendEmail(cc, subject, html);
  await db.execute({ sql: 'UPDATE first_booking_requests SET email_status = ? WHERE id = ?', args: [emailStatus, id] });
  if (!isTest) try {
    await alerts.opsPost(`:calendar: *${esc(centreName)} wants to create their first ${fbf ? 'free ' : ''}booking* (clicked Yes in a Journey 1 email).${who.ownerName ? ` Owner: ${esc(who.ownerName)}.` : ''} ${isLead ? 'Not in RT yet: create the centre first. ' : ''}<${taskLink}|Open task>`);
  } catch (_) { /* best effort */ }
  return { ok: true, recorded: true };
}

async function recent(limit = 50) {
  return (await getDb().execute({ sql: 'SELECT * FROM first_booking_requests ORDER BY created_at DESC LIMIT ?', args: [limit] })).rows;
}

module.exports = { createRequest, identify, recent };
