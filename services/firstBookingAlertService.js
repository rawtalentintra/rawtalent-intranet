// First booking alert (Liam + Sophia, 11 Nov 2026, Fathom 897390006 at 0:40).
//
// When a centre makes its FIRST booking, its owner (Gwen / Justine / Liam, by
// relationship: centre_partner_assignments, else the state default) hears about
// it straight away, so nobody finds out the next afternoon like Aussie
// Adventures. Internal only, plain system messages:
//   1. Booking created  -> email (Customer.io send API) + Slack DM to the owner,
//                          and a post in today's #daily-check-in thread tagging
//                          Ops (Sophia) so the team sees it too.
//   2. Booking filled   -> Slack DM to the owner + thread post, and a HeartBeat
//                          task for the owner due the morning after the shift:
//                          "call them: how was your first booking?" (Liam, 11
//                          Nov, Fathom 897427111: Wednesday booking -> Thursday
//                          morning call). The call is where the centre is shown
//                          favourite/request and asked to rate the educator
//                          positive in the Portal (that rating drives the
//                          Customer.io feedback journey, so it stays in the Portal).
//   3. Booking cancelled or unfilled before it was filled -> one heads-up to the owner.
//
// "First booking" = the earliest-created, non-deleted RT booking at that centre.
// HeartBeat holds ~12 months of RT bookings, so only centres created in RT in the
// last 300 days are checked (an older centre's real first booking may be outside
// the window). The first run records every centre that already has bookings as
// a baseline and sends nothing, so switching this on never backfills old alerts.

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const ELIGIBLE_CENTRE_AGE_DAYS = 300;
const FILLED_STATUSES = new Set([2, 3, 5]);      // requested/assigned, confirmed, completed (same as fill rate)
const DEAD_STATUSES = new Set([6, 7]);           // cancelled, unfilled
const OPS_TAG_EMAILS = ['sophia@rawtalent.com.au'];
const CLIENT_FOLLOW_UP = '4c6ae463-b50e-43b5-934a-a81572c024e9'; // Tasks: management -> Client Follow up
const APP_URL = 'https://rawtalent-internal.app';
const TZ = 'Australia/Melbourne';

const esc = x => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const melDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const niceDate = ymd => { if (!ymd) return ''; const d = new Date(ymd + 'T00:00:00Z'); return d.toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }); };
const hhmm = t => { const m = String(t || '').match(/T(\d{2}):(\d{2})/); if (!m) return ''; let h = +m[1]; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${m[2]}${ap}`; };
const isReal = id => id != null && id !== 0;

function bookingsFor(centre, bookings) {
  return bookings.filter(b => !b.isDeleted && (centre.rtLocationId
    ? String(b.locationId) === String(centre.rtLocationId)
    : String(b.clientId) === String(centre.rtClientId)));
}
function firstOf(list) {
  return [...list].sort((a, b) => new Date(a.createdDate || a.bookingDate) - new Date(b.createdDate || b.bookingDate))[0] || null;
}
function describe(b) {
  const day = (b.bookingDate || '').slice(0, 10);
  const time = hhmm(b.startTime) && hhmm(b.endTime) ? `${hhmm(b.startTime)} to ${hhmm(b.endTime)}` : '';
  return { day, when: [niceDate(day), time].filter(Boolean).join(', '), by: b.createdByName || '', educator: b.assignedCandidateName || '' };
}
// Morning after the shift, Melbourne date (YYYY-MM-DD).
function morningAfter(day) {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
}

async function owner(centreKey) {
  const { ownerFields } = require('./firstBookingFreeService');
  const f = await ownerFields(centreKey);
  return { name: f.wfp_owner_name || 'Liam', email: f.wfp_owner_email || 'liam@rawtalent.com.au' };
}

// Internal email through Customer.io's transactional send API (inline content,
// one auto-created message "Internal | First booking alert" so sends show in
// Customer.io's delivery log). Never throws; returns a short status.
async function sendEmail(to, subject, html) {
  const key = process.env.CUSTOMERIO_APP_API_KEY;
  if (!key) return 'no_key';
  const host = String(process.env.CUSTOMERIO_REGION || '').toLowerCase() === 'eu' ? 'api-eu.customer.io' : 'api.customer.io';
  try {
    const r = await fetch(`https://${host}/v1/send/email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactional_message_id: 'Internal | First booking alert', auto_create: true,
        identifiers: { email: to }, to, from: 'Raw Talent HeartBeat <contact@rawtalent.com.au>',
        subject, body: html, send_to_unsubscribed: true, tracked: false
      })
    });
    if (!r.ok) { console.error('First booking alert email failed:', r.status, (await r.text()).slice(0, 200)); return 'failed_' + r.status; }
    return 'sent';
  } catch (err) { console.error('First booking alert email error:', err.message); return 'error'; }
}

// RT's backoffice has no shareable per-booking URL (its Booking Details page only opens
// from inside the app; a direct link loads blank), so the email links to the backoffice and
// gives the Booking ID to search in Bookings.
const RT_BACKOFFICE_URL = 'https://backoffice.rawtalent.com.au/';
function firstBookingEmail({ ownerName, centreName, when, bookedBy, status, bookingId, heartbeatLink }) {
  const p = t => `<p style="margin:0 0 12px">${t}</p>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#21275D;max-width:560px">
${p(`Hi ${esc(ownerName)},`)}
${p(`Please be notified that your centre, <strong>${esc(centreName)}</strong>, has made its first booking.`)}
${p(`<strong>Shift:</strong> ${esc(when)}${bookedBy ? `<br><strong>Booked by:</strong> ${esc(bookedBy)}` : ''}<br><strong>Status:</strong> ${esc(status || 'Open')}<br><strong>Booking ID:</strong> ${esc(bookingId)}`)}
<p style="margin:18px 0 12px"><a href="${RT_BACKOFFICE_URL}" style="display:inline-block;background:#21275D;color:#ffffff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:6px">View the booking in RawTalent Portal</a></p>
${p(`<span style="font-size:13px;color:#6b7280">In the Portal, go to Bookings and search for booking ${esc(bookingId)}.</span>`)}
${p(`You'll get another message when it's filled, and a task to call them the morning after the shift.`)}
${heartbeatLink ? p(`<a href="${heartbeatLink}" style="color:#0369a1">Open ${esc(centreName)} in HeartBeat</a>`) : ''}
<p style="margin:18px 0 0;font-size:12px;color:#6b7280">Sent automatically by HeartBeat. Internal only.</p></div>`;
}

async function slackDm(email, text, mrkdwn) {
  const slack = require('./slackService');
  return slack.sendDmByEmail(email, text, [{ type: 'section', text: { type: 'mrkdwn', text: mrkdwn } }]);
}
// Post in today's "HeartBeat Tasks for today" thread in #daily-check-in, tagging Ops.
async function opsPost(mrkdwn) {
  const slack = require('./slackService');
  if (!slack.isConfigured()) return false;
  try {
    const tags = [];
    for (const e of OPS_TAG_EMAILS) { const id = await slack.slackUserId(e); if (id) tags.push(`<@${id}>`); }
    await slack.postToDailyThread(`${mrkdwn}${tags.length ? `\n${tags.join(' ')} for Ops` : ''}`);
    return true;
  } catch (err) { console.error('First booking alert Ops post failed:', err.message); return false; }
}

const melNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
};
const REMINDER_AT = '07:30';   // Melbourne, on the morning the call is due
const ESCALATE_AT = '12:00';   // not logged by midday -> Liam + Ops hear about it
const ESCALATE_TO = ['liam@rawtalent.com.au'];

const CALL_SCRIPT = `On the call:\n• Ask how the booking went and how the educator did.\n• If it went well, show them how to favourite and request that educator in the Portal.\n• Log the call (or visit) on the centre in HeartBeat and choose Positive or Negative for their first booking. That closes this task, and Positive starts their next emails.`;

async function createFollowUpTask(row, own, b) {
  const d = describe(b);
  const today = melNow().day;
  const due = [morningAfter(d.day), today].sort().pop(); // filled late -> due today
  const taskId = uuidv4();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
          VALUES (?, 'management', ?, ?, ?, 'to_do', 'urgent', ?, ?, 'system@rawtalent.internal', 'Auto — First booking', '[]', '[]', ?)`,
    args: [taskId, CLIENT_FOLLOW_UP, `URGENT: Call ${row.centre_name} the morning after their first booking`,
      `${row.centre_name} had their first ever booking on ${d.when}${d.educator ? `, filled by ${d.educator}` : ''}.\n\n` +
      `Call them on the morning of ${niceDate(due)}. Not two days later: the morning after the shift. This is the most important follow-up in the whole relationship (Liam).\n\n` + CALL_SCRIPT,
      JSON.stringify([own.email]), due, JSON.stringify([{ centreKey: row.centre_key, name: row.centre_name }])]
  });
  try { await require('./slackService').notifyTaskTagged(taskId, [own.email], 'assigned to'); } catch (_) { /* best effort */ }
  return { taskId, due };
}

// Morning-after follow-up (Liam, 11 Nov 2026, Fathom 897427111): reminder at 7:30am on
// the due morning, done as soon as anyone logs a completed call/visit on that centre
// from the shift day on (or the task is ticked), Liam + Ops told at midday if not.
async function followUps() {
  const db = getDb();
  const rows = (await db.execute({ sql: "SELECT * FROM first_booking_alerts WHERE status = 'followup'", args: [] })).rows;
  const now = melNow();
  const out = { done: 0, reminded: 0, escalated: 0 };
  for (const r of rows) {
    const shiftDay = r.booking_date ? String(r.booking_date instanceof Date ? r.booking_date.toISOString() : r.booking_date).slice(0, 10) : null;
    const due = String(r.followup_due instanceof Date ? r.followup_due.toISOString() : r.followup_due).slice(0, 10);
    const logged = (await db.execute({ sql: `SELECT created_by_name, created_by_email, channel, visit_date FROM centre_visits
        WHERE centre_key = ? AND status = 'completed' AND (visit_date AT TIME ZONE 'Australia/Melbourne')::date >= ?::date ORDER BY visit_date LIMIT 1`, args: [r.centre_key, shiftDay || due] })).rows[0];
    const task = r.task_id ? (await db.execute({ sql: 'SELECT status FROM tasks WHERE id = ?', args: [r.task_id] })).rows[0] : null;
    if ((logged && r.outcome) || (task && task.status === 'done')) {
      await db.execute({ sql: "UPDATE first_booking_alerts SET status = 'done', followup_done_at = now(), followup_by = ? WHERE centre_key = ?", args: [logged ? (logged.created_by_name || logged.created_by_email) : 'task ticked', r.centre_key] });
      if (logged && task && task.status !== 'done') await db.execute({ sql: "UPDATE tasks SET status = 'done', completed_at = now(), updated_at = now() WHERE id = ?", args: [r.task_id] });
      out.done++; continue;
    }
    const taskLink = `${APP_URL}/?tab=tasks&task=${r.task_id}`;
    if (!r.reminder_sent_at && (now.day > due || (now.day === due && now.hm >= REMINDER_AT))) {
      const first = String(r.owner_name || '').split(' ')[0] || 'there';
      await slackDm(r.owner_email, `Call ${r.centre_name} this morning`, `:telephone_receiver: *Call ${esc(r.centre_name)} this morning.* Their first booking was ${esc(niceDate(shiftDay))}.\nAsk how it went and show them favourite/request. Then in HeartBeat log the call and choose Positive or Negative: that clears this and (if Positive) starts their next emails. <${taskLink}|Open task>`);
      await sendEmail(r.owner_email, `Call ${r.centre_name} this morning`, `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#21275D;max-width:560px">
<p>Hi ${esc(first)},</p><p>Please call <strong>${esc(r.centre_name)}</strong> this morning. Their first booking was ${esc(niceDate(shiftDay))}, and this call is the most important follow-up in the relationship.</p>
<p>On the call:</p><ul><li>Ask how the booking went and how the educator did.</li><li>If it went well, show them how to favourite and request that educator in the Portal.</li></ul>
<p>Then log the call (or visit) on the centre in HeartBeat and choose <strong>Positive</strong> or <strong>Negative</strong> for their first booking. That closes the task, and Positive starts their next emails.</p>
<p><a href="${taskLink}" style="color:#0369a1">Open the task in HeartBeat</a></p>
<p style="font-size:12px;color:#6b7280">Sent automatically by HeartBeat. Internal only.</p></div>`);
      await db.execute({ sql: 'UPDATE first_booking_alerts SET reminder_sent_at = now() WHERE centre_key = ?', args: [r.centre_key] });
      out.reminded++;
    }
    if (!r.escalated_at && (now.day > due || (now.day === due && now.hm >= ESCALATE_AT))) {
      const msg = `:rotating_light: *Morning-after call not logged yet: ${esc(r.centre_name)}* (${esc(r.owner_name)}'s centre). First booking was ${esc(niceDate(shiftDay))}; the call was due this morning. <${taskLink}|Open task>`;
      for (const e of ESCALATE_TO) await slackDm(e, `Morning-after call not logged: ${r.centre_name}`, msg);
      await opsPost(msg);
      await db.execute({ sql: 'UPDATE first_booking_alerts SET escalated_at = now() WHERE centre_key = ?', args: [r.centre_key] });
      out.escalated++;
    }
  }
  return out;
}

// For Today on /wfp and Centre 360: centres whose morning-after call is still open.
async function openFollowUps() {
  const rows = (await getDb().execute({ sql: "SELECT centre_key, centre_name, booking_date, followup_due, owner_name, task_id, escalated_at FROM first_booking_alerts WHERE status = 'followup'", args: [] })).rows;
  const ymd = v => v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null;
  return Object.fromEntries(rows.map(r => [r.centre_key, { shiftDate: ymd(r.booking_date), due: ymd(r.followup_due), owner: r.owner_name, taskId: r.task_id, escalated: !!r.escalated_at }]));
}

// ── First booking outcome (Liam, 16 Nov 2026, Fathom 900546391 at 20:40 / 34:10) ──────────
// After the morning-after call the WFP registers Positive or Negative. HeartBeat sends
// Customer.io `first_booking_outcome_registered` {booking_id, outcome, ...} to the person who
// created the first booking (RT person id = Customer.io id, same profile Journey 2 runs on),
// plus attribute first_booking_outcome. Journey 2 (#39 / #44) waits for outcome = positive
// before Email 3 onward. RT Portal's own outcome can replace this once RT sends it (Joy, 18 Nov).
const OUTCOMES = new Set(['positive', 'negative']);
async function sendOutcomeSignal(centreKey) {
  const db = getDb();
  const r = (await db.execute({ sql: 'SELECT * FROM first_booking_alerts WHERE centre_key = ?', args: [centreKey] })).rows[0];
  if (!r || !r.outcome) return 'no_outcome';
  const fbf = require('./firstBookingFreeService');
  if (!fbf.cioTrackConfig().ready) {
    await db.execute({ sql: "UPDATE first_booking_alerts SET outcome_signal = 'pending' WHERE centre_key = ?", args: [centreKey] });
    return 'pending';
  }
  try {
    const { bookings } = await require('../routes/centres').getCentresAndBookings();
    const b = bookings.find(x => String(x.clientBookingId) === String(r.booking_id));
    const ident = b && isReal(b.createdBy) ? String(b.createdBy) : null;
    if (!ident) {
      await db.execute({ sql: "UPDATE first_booking_alerts SET outcome_signal = 'no_profile' WHERE centre_key = ?", args: [centreKey] });
      return 'no_profile';
    }
    const at = Math.floor(new Date(r.outcome_at || Date.now()).getTime() / 1000);
    await fbf.sendCioSignal(ident, { first_booking_outcome: r.outcome, first_booking_outcome_at: at },
      'first_booking_outcome_registered',
      { booking_id: String(r.booking_id), outcome: r.outcome, centre_key: centreKey, centre_name: r.centre_name, registered_by: r.outcome_by || '', registered_at: at });
    await db.execute({ sql: "UPDATE first_booking_alerts SET outcome_signal = 'sent' WHERE centre_key = ?", args: [centreKey] });
    return 'sent';
  } catch (err) {
    console.error('First booking outcome signal failed:', err.message);
    await db.execute({ sql: "UPDATE first_booking_alerts SET outcome_signal = 'failed' WHERE centre_key = ?", args: [centreKey] });
    return 'failed';
  }
}
async function registerOutcome(centreKey, outcome, user) {
  outcome = String(outcome || '').toLowerCase();
  if (!OUTCOMES.has(outcome)) { const e = new Error('Choose Positive or Negative'); e.status = 400; throw e; }
  const db = getDb();
  const r = (await db.execute({ sql: "SELECT * FROM first_booking_alerts WHERE centre_key = ? AND status IN ('created','followup','done')", args: [centreKey] })).rows[0];
  if (!r) { const e = new Error('No first booking to rate for this centre'); e.status = 404; throw e; }
  const by = (user && (user.name || user.email)) || '';
  await db.execute({ sql: "UPDATE first_booking_alerts SET outcome = ?, outcome_by = ?, outcome_at = now() WHERE centre_key = ?", args: [outcome, by, centreKey] });
  // The outcome completes the morning-after follow-up (and its task).
  if (r.status === 'followup') {
    await db.execute({ sql: "UPDATE first_booking_alerts SET status = 'done', followup_done_at = now(), followup_by = ? WHERE centre_key = ?", args: [by, centreKey] });
    if (r.task_id) await db.execute({ sql: "UPDATE tasks SET status = 'done', completed_at = now(), updated_at = now() WHERE id = ? AND status <> 'done'", args: [r.task_id] });
  }
  const signal = await sendOutcomeSignal(centreKey);
  return { outcome, signal };
}
async function retryOutcomeSignals() {
  const rows = (await getDb().execute({ sql: "SELECT centre_key FROM first_booking_alerts WHERE outcome IS NOT NULL AND outcome_signal IN ('pending','failed','no_profile')", args: [] })).rows;
  let sent = 0;
  for (const r of rows) if ((await sendOutcomeSignal(r.centre_key)) === 'sent') sent++;
  return sent;
}

async function check() {
  const db = getDb();
  const { getCentresAndBookings } = require('../routes/centres');
  const { centres, bookings } = await getCentresAndBookings();
  if (!Array.isArray(bookings) || !bookings.length) return { skipped: 'no bookings loaded' };
  const known = new Map((await db.execute({ sql: 'SELECT * FROM first_booking_alerts', args: [] })).rows.map(r => [r.centre_key, r]));
  const firstRun = known.size === 0;
  const cutoff = Date.now() - ELIGIBLE_CENTRE_AGE_DAYS * 86400000;
  const out = { baseline: 0, created: 0, filled: 0, dead: 0 };

  for (const c of centres) {
    const row0 = known.get(c.centreKey);
    if (row0 && row0.status !== 'created') continue;
    if (!row0 && !(new Date(c.createdDate).getTime() >= cutoff)) continue;
    const mine = bookingsFor(c, bookings);
    const b = firstOf(mine);
    if (!b) continue;

    if (!row0) {
      if (firstRun) {
        await db.execute({ sql: "INSERT INTO first_booking_alerts (centre_key, centre_name, booking_id, booking_date, status) VALUES (?,?,?,?, 'baseline') ON CONFLICT (centre_key) DO NOTHING", args: [c.centreKey, c.name, String(b.clientBookingId), (b.bookingDate || '').slice(0, 10) || null] });
        out.baseline++; continue;
      }
      // 1. New first booking
      const own = await owner(c.centreKey);
      const d = describe(b);
      const link = `${APP_URL}/go/centre/${encodeURIComponent(c.centreKey)}`;
      const ins = await db.execute({ sql: "INSERT INTO first_booking_alerts (centre_key, centre_name, booking_id, booking_date, owner_name, owner_email, status, created_alert_at) VALUES (?,?,?,?,?,?, 'created', now()) ON CONFLICT (centre_key) DO NOTHING RETURNING centre_key", args: [c.centreKey, c.name, String(b.clientBookingId), d.day || null, own.name, own.email] });
      if (!ins.rows.length) continue; // another instance got it first
      const emailStatus = await sendEmail(own.email, `First booking: ${c.name}`, firstBookingEmail({ ownerName: own.name, centreName: c.name, when: d.when, bookedBy: d.by, status: b.bookingStatus, bookingId: b.clientBookingId, heartbeatLink: link }));
      const dm = await slackDm(own.email, `First booking: ${c.name}`, `:tada: *First booking: ${esc(c.name)}*\nShift: ${esc(d.when)}${d.by ? ` · booked by ${esc(d.by)}` : ''}\nYou'll get a message when it's filled. <${link}|Open in HeartBeat>`);
      await opsPost(`:tada: *First booking:* ${esc(c.name)} (${esc(own.name)}'s centre). Shift ${esc(d.when)}. Let's make sure it's filled.`);
      await db.execute({ sql: 'UPDATE first_booking_alerts SET email_status = ?, slack_dm = ? WHERE centre_key = ?', args: [emailStatus, dm, c.centreKey] });
      known.set(c.centreKey, { centre_key: c.centreKey, centre_name: c.name, booking_id: String(b.clientBookingId), status: 'created', owner_name: own.name, owner_email: own.email });
      out.created++;
    }

    const row = known.get(c.centreKey);
    if (row.status !== 'created') continue;
    // Follow the same booking we alerted on.
    const cur = mine.find(x => String(x.clientBookingId) === String(row.booking_id)) || b;
    const own = { name: row.owner_name || 'Liam', email: row.owner_email || 'liam@rawtalent.com.au' };
    const d = describe(cur);
    if (FILLED_STATUSES.has(cur.statusId) && isReal(cur.assignedUserId)) {
      // 2. Filled
      const { taskId, due } = await createFollowUpTask(row, own, cur);
      await slackDm(own.email, `First booking filled: ${row.centre_name}`, `:white_check_mark: *First booking filled: ${esc(row.centre_name)}*\n${esc(d.when)}${d.educator ? ` · ${esc(d.educator)}` : ''}\n*Call them on the morning of ${esc(niceDate(due))}.* You'll get a reminder that morning. <${APP_URL}/?tab=tasks&task=${taskId}|Open task>`);
      await opsPost(`:white_check_mark: *First booking filled:* ${esc(row.centre_name)}, ${esc(d.when)}${d.educator ? `, ${esc(d.educator)}` : ''}. ${esc(own.name)} calls them the morning of ${esc(niceDate(due))}.`);
      await db.execute({ sql: "UPDATE first_booking_alerts SET status = 'followup', filled_alert_at = now(), task_id = ?, followup_due = ? WHERE centre_key = ?", args: [taskId, due, c.centreKey] });
      out.filled++;
    } else if (DEAD_STATUSES.has(cur.statusId)) {
      // 3. Cancelled / unfilled before it was filled
      await slackDm(own.email, `First booking ${cur.statusId === 7 ? 'unfilled' : 'cancelled'}: ${row.centre_name}`, `:warning: *${esc(row.centre_name)}'s first booking was ${cur.statusId === 7 ? 'marked unfilled' : 'cancelled'}* (${esc(d.when)}). Worth a call to keep them warm.`);
      await opsPost(`:warning: ${esc(row.centre_name)}'s first booking (${esc(d.when)}) was ${cur.statusId === 7 ? 'marked unfilled' : 'cancelled'}.`);
      await db.execute({ sql: "UPDATE first_booking_alerts SET status = 'done', dead_alert_at = now() WHERE centre_key = ?", args: [c.centreKey] });
      out.dead++;
    }
  }
  return out;
}

let running = null;
function run() {
  if (running) return running;
  running = check().then(async r => ({ ...r, followUps: await followUps(), outcomeSignals: await retryOutcomeSignals().catch(() => 0) })).catch(err => { console.error('First booking alert check failed:', err.message); return { error: err.message }; }).finally(() => { running = null; });
  return running;
}

module.exports = { registerOutcome, sendOutcomeSignal, retryOutcomeSignals, run, check, followUps, openFollowUps, melNow, sendEmail, opsPost, slackDm, firstBookingEmail, morningAfter, describe, firstOf };
