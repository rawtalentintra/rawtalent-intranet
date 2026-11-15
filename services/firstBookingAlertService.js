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

function emailHtml(lines, link) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#21275D;max-width:560px">
${lines.map(l => `<p style="margin:0 0 12px">${l}</p>`).join('\n')}
<p style="margin:18px 0 0"><a href="${link}" style="color:#0369a1">Open the centre in HeartBeat</a></p>
<p style="margin:18px 0 0;font-size:12px;color:#6b7280">Sent automatically by HeartBeat to the centre's Workforce Partner. Internal only.</p></div>`;
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

async function createFollowUpTask(row, own, b) {
  const d = describe(b);
  const due = morningAfter(d.day);
  const taskId = uuidv4();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
          VALUES (?, 'management', ?, ?, ?, 'to_do', 'high', ?, ?, 'system@rawtalent.internal', 'Auto — First booking', '[]', '[]', ?)`,
    args: [taskId, CLIENT_FOLLOW_UP, `Call ${row.centre_name}: how was their first booking?`,
      `${row.centre_name} had their first ever booking on ${d.when}${d.educator ? `, filled by ${d.educator}` : ''}.\n\n` +
      `Please call them on the morning of ${niceDate(due)} (the morning after the shift). This first call is the moment that builds the relationship.\n\n` +
      `On the call:\n• Ask how the booking went and how the educator did.\n• If it went well, show them how to favourite and request that educator in the Portal.\n• Ask them to rate the educator Positive in the Portal (that rating is what starts the feedback emails).\n• Log the call on the centre in HeartBeat.`,
      JSON.stringify([own.email]), due, JSON.stringify([{ centreKey: row.centre_key, name: row.centre_name }])]
  });
  try { await require('./slackService').notifyTaskTagged(taskId, [own.email], 'assigned to'); } catch (_) { /* best effort */ }
  return taskId;
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
    if (row0 && (row0.status === 'baseline' || row0.status === 'done')) continue;
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
      const link = `${APP_URL}/admin?centre=${encodeURIComponent(c.centreKey)}`;
      const ins = await db.execute({ sql: "INSERT INTO first_booking_alerts (centre_key, centre_name, booking_id, booking_date, owner_name, owner_email, status, created_alert_at) VALUES (?,?,?,?,?,?, 'created', now()) ON CONFLICT (centre_key) DO NOTHING RETURNING centre_key", args: [c.centreKey, c.name, String(b.clientBookingId), d.day || null, own.name, own.email] });
      if (!ins.rows.length) continue; // another instance got it first
      const emailStatus = await sendEmail(own.email, `First booking: ${c.name}`, emailHtml([
        `Hi ${esc(own.name)},`,
        `<strong>${esc(c.name)}</strong> has just made their <strong>first booking</strong> with Raw Talent.`,
        `Shift: ${esc(d.when)}${d.by ? `<br>Booked by: ${esc(d.by)}` : ''}<br>Status: ${esc(b.bookingStatus || 'Open')}`,
        `You'll get another message when it's filled, and a task to call them the morning after the shift.`
      ], link));
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
      const taskId = await createFollowUpTask(row, own, cur);
      await slackDm(own.email, `First booking filled: ${row.centre_name}`, `:white_check_mark: *First booking filled: ${esc(row.centre_name)}*\n${esc(d.when)}${d.educator ? ` · ${esc(d.educator)}` : ''}\nYou have a task to call them the morning after: <${APP_URL}/?tab=tasks&task=${taskId}|open task>`);
      await opsPost(`:white_check_mark: *First booking filled:* ${esc(row.centre_name)}, ${esc(d.when)}${d.educator ? `, ${esc(d.educator)}` : ''}.`);
      await db.execute({ sql: "UPDATE first_booking_alerts SET status = 'done', filled_alert_at = now(), task_id = ? WHERE centre_key = ?", args: [taskId, c.centreKey] });
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
  running = check().catch(err => { console.error('First booking alert check failed:', err.message); return { error: err.message }; }).finally(() => { running = null; });
  return running;
}

module.exports = { run, check, sendEmail, morningAfter, describe, firstOf };
