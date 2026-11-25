// Educator Texts (Joy, 24 Nov 2026). Sends SMS to educators through
// Customer.io's transactional SMS API and stores both directions in
// sms_messages, so HeartBeat shows the whole conversation.
//
// Sending: POST https://api.customer.io/v1/send/sms with the transactional
// message 'heartbeat_sms' (its template body is just {{trigger.body}}), the
// educator's Customer.io id (= RT userId) and their mobile in E.164.
// Replies: a Customer.io inbound automation on the `sms` event calls
// /api/public/sms-inbound with a webhook (see routes/educatorTexts.js).
//
// Guard rails so texts aren't sent carelessly (all overridable by env var):
//  - every message's segment count and estimated cost is shown before sending
//  - per-person daily segment cap, max recipients per mass send
//  - an educator texted in the last 24 hours is skipped unless they replied
//  - no time-of-day limit: Joy asked to allow after-hours sends (25 Nov 2026)
//  - the queue drains one message every ~1.2s (Twilio long code pace), in the
//    background, so a mass send never blocks the page or the server
// STOP / START replies are handled by Customer.io itself (opted-out numbers
// are suppressed automatically).
const crypto = require('crypto');
const { getDb } = require('../db/database');

const TX_MESSAGE = process.env.SMS_TRANSACTIONAL_ID || 'heartbeat_sms';
const LIMITS = {
  dailySegmentsPerSender: Number(process.env.SMS_DAILY_SEGMENTS_PER_SENDER) || 300,
  maxRecipientsPerSend: Number(process.env.SMS_MAX_RECIPIENTS) || 200,
  cooldownHours: Number(process.env.SMS_COOLDOWN_HOURS) || 24,
  costPerSegmentAud: Number(process.env.SMS_COST_PER_SEGMENT_AUD) || 0.08,
  sendFromHour: 0, sendToHour: 24
};

// RawTalent announcements (one-way, sender name "RawTalent", replies impossible):
// Joy + Sophia only (Joy, 25 Nov 2026). Needs its own Customer.io transactional
// message using the alphanumeric sender, id in SMS_ANNOUNCE_TRANSACTIONAL_ID.
const ANNOUNCE_EMAILS = (process.env.SMS_ANNOUNCE_EMAILS || 'joy@rawtalent.com.au,sophia@rawtalent.com.au').toLowerCase().split(',').map(s => s.trim());
const ANNOUNCE_TX = process.env.SMS_ANNOUNCE_TRANSACTIONAL_ID || 'heartbeat_sms_announcement'; // Customer.io transactional #7, sender "RawTalent" (identity 8)
function canAnnounce(user) { return !!user && ANNOUNCE_EMAILS.includes(String(user.email || '').toLowerCase()); }
// Live for everyone (Joy, 25 Nov 2026). Announcements stay Joy/Sophia only (canAnnounce).
// Approval gate (Joy, 25 Nov 2026): a send to more than APPROVAL_OVER people waits
// for Sophia, who gets a Slack DM linking to /sms-approval/:batchId.
const APPROVAL_OVER = 10;
const APPROVER_EMAIL = (process.env.SMS_APPROVER_EMAIL || 'sophia@rawtalent.com.au').toLowerCase();
const isApprover = user => !!user && String(user.email || '').toLowerCase() === APPROVER_EMAIL;
function needsApproval(user, count) { return count > APPROVAL_OVER && !isApprover(user); }

function canSendTexts(user) {
  return !!user && user.active !== false;
}

// ── Segments ──────────────────────────────────────────────────────────────
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';
// Same typography fixes Customer.io's smart encoding applies before sending.
const smart = t => String(t || '').replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
  .replace(/[–—‒−]/g, '-').replace(/…/g, '...').replace(/ /g, ' ');
function segmentInfo(text) {
  const t = smart(text);
  let units = 0, gsm = true;
  for (const ch of t) { if (GSM.includes(ch)) units += 1; else if (GSM_EXT.includes(ch)) units += 2; else { gsm = false; break; } }
  if (!gsm) { const n = [...t].length; return { encoding: 'UCS-2', chars: n, segments: n <= 70 ? 1 : Math.ceil(n / 67) }; }
  return { encoding: 'GSM-7', chars: units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
}

// RT stores mobiles as 04xx xxx xxx / +614... ; Customer.io wants E.164.
function toE164(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return /^\+61[2-9]\d{8}$/.test(d) ? d : null;
  if (d.startsWith('61')) d = d.slice(2);
  d = d.replace(/^0/, '');
  return /^4\d{8}$/.test(d) ? '+61' + d : null; // mobiles only
}

function melbourneHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', hour: 'numeric', hourCycle: 'h23' }).format(d));
}
const inSendWindow = () => { const h = melbourneHour(); return h >= LIMITS.sendFromHour && h < LIMITS.sendToHour; };

// Secret for the Customer.io reply webhook: derived from SESSION_SECRET so no
// new env var is needed. Only super admins can read it (routes/educatorTexts.js).
const inboundSecret = () => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev').update('sms-inbound').digest('hex').slice(0, 32);

async function segmentsSentToday(email) {
  const r = (await getDb().execute({
    sql: `SELECT coalesce(sum(segments),0) n FROM sms_messages WHERE direction = 'out' AND sent_by_email = ? AND status IN ('queued','sending','sent','pending_approval')
            AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') AT TIME ZONE 'Australia/Melbourne')`,
    args: [email]
  })).rows[0];
  return Number(r.n) || 0;
}

// recipients: [{ userId, name, phone }] from the server-side educator list.
async function queueSend({ recipients, body, user, audienceNote, ignoreCooldown = false, sender = 'number', tag = null, title = null }) {
  if (sender !== 'number' && sender !== 'announcement') sender = 'number';
  if (sender === 'announcement') {
    if (!canAnnounce(user)) throw Object.assign(new Error('Only Joy and Sophia can send RawTalent announcements.'), { status: 403 });
    if (!ANNOUNCE_TX) throw Object.assign(new Error('RawTalent announcement sender is not set up in Customer.io yet.'), { status: 400 });
  }
  const text = smart(body).trim();
  if (!text) throw Object.assign(new Error('Write a message first'), { status: 400 });
  if (text.length > 600) throw Object.assign(new Error('Keep texts under 600 characters'), { status: 400 });
  if (recipients.length > LIMITS.maxRecipientsPerSend) throw Object.assign(new Error(`One send can go to at most ${LIMITS.maxRecipientsPerSend} people. Narrow the filters.`), { status: 400 });
  // {first_name} is filled per educator; cost is based on the longest result.
  const first = r => (String(r.firstName || r.name || '').trim().split(/\s+/)[0] || 'there');
  const render = r => text.replace(/\{first_name\}/gi, first(r));
  const seg = recipients.length ? recipients.map(r => segmentInfo(render(r))).sort((a, b) => b.segments - a.segments)[0] : segmentInfo(text);
  const db = getDb();

  const skipped = [];
  const ids = recipients.map(r => String(r.userId));
  // Cool-down: last outbound in the window, unless they've replied since.
  const recent = ids.length ? (await db.execute({
    sql: `SELECT educator_id, max(created_at) FILTER (WHERE direction='out' AND status IN ('queued','sending','sent','pending_approval')) last_out,
                 max(created_at) FILTER (WHERE direction='in') last_in
          FROM sms_messages WHERE educator_id = ANY(?) AND created_at > now() - make_interval(hours => ?) GROUP BY educator_id`,
    args: [ids, LIMITS.cooldownHours]
  })).rows : [];
  const blocked = new Set(recent.filter(r => r.last_out && !(r.last_in && r.last_in > r.last_out)).map(r => r.educator_id));

  const ok = [], seenPhones = new Set();
  for (const r of recipients) {
    const phone = toE164(r.phone);
    if (!phone) { skipped.push({ ...r, why: 'No valid mobile number' }); continue; }
    // Several centres in a group often share one mobile: text it once.
    if (seenPhones.has(phone)) { skipped.push({ ...r, why: 'Same mobile as another recipient in this send' }); continue; }
    seenPhones.add(phone);
    if (!ignoreCooldown && blocked.has(String(r.userId))) { skipped.push({ ...r, why: `Texted in the last ${LIMITS.cooldownHours} hours` }); continue; }
    ok.push({ ...r, phone });
  }
  const need = ok.length * seg.segments;
  const used = await segmentsSentToday(user.email);
  if (used + need > LIMITS.dailySegmentsPerSender) {
    throw Object.assign(new Error(`That's ${need} SMS segments, and you have ${Math.max(0, LIMITS.dailySegmentsPerSender - used)} left today (daily limit ${LIMITS.dailySegmentsPerSender}).`), { status: 429 });
  }
  if (!ok.length) return { queued: 0, skipped, segments: seg.segments, estCostAud: 0 };

  const gated = needsApproval(user, ok.length);
  // Booking / Onboarding tag chosen on the send goes onto each conversation.
  if (tag) await db.execute({ sql: `INSERT INTO sms_tags (educator_id, tag, tagged_by, tagged_at) SELECT x, ?, ?, now() FROM unnest(?::text[]) x
    ON CONFLICT (educator_id) DO UPDATE SET tag = excluded.tag, tagged_by = excluded.tagged_by, tagged_at = now()`, args: [tag, user.email, ok.map(r => String(r.userId))] });
  const batch = (await db.execute({
    sql: `INSERT INTO sms_batches (sent_by_email, sent_by_name, body, audience_note, recipient_count, segments_per_message, approval_status, tag, title) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
    args: [user.email, user.name || user.email, text, audienceNote || null, ok.length, seg.segments, gated ? 'pending' : null, tag, title ? String(title).trim().slice(0, 80) : null]
  })).rows[0];
  for (const r of ok) {
    await db.execute({
      sql: `INSERT INTO sms_messages (educator_id, educator_name, phone, direction, body, segments, status, batch_id, sent_by_email, sent_by_name, snap_status, snap_compliant, recipient_type, cio_id, sender)
            VALUES (?,?,?,'out',?,?,?,?,?,?,?,?,?,?,?)`,
      args: [String(r.userId), r.name || null, r.phone, render(r), segmentInfo(render(r)).segments, gated ? 'pending_approval' : 'queued', batch.id, user.email, user.name || user.email,
             r.status || null, r.compliant == null ? null : !!r.compliant, r.type || 'educator', String(r.cioId || r.userId), sender]
    });
  }
  if (gated) {
    notifyApprover(batch.id, user, ok.length, text, audienceNote).catch(e => console.error('[sms] approval Slack:', e.message));
    return { queued: 0, pendingApproval: ok.length, skipped, segments: seg.segments, estCostAud: +(need * LIMITS.costPerSegmentAud).toFixed(2), batchId: batch.id };
  }
  kick();
  return { queued: ok.length, skipped, segments: seg.segments, estCostAud: +(need * LIMITS.costPerSegmentAud).toFixed(2), batchId: batch.id, waitsForMorning: !inSendWindow() };
}

// ── Background queue ──────────────────────────────────────────────────────
let draining = false, timer = null;
function kick() { if (!draining) { clearTimeout(timer); timer = setTimeout(drain, 50); } }
async function drain() {
  if (draining) return;
  draining = true;
  try {
    const key = process.env.CUSTOMERIO_APP_API_KEY;
    if (!key || !inSendWindow()) return;
    const host = String(process.env.CUSTOMERIO_REGION || '').toLowerCase() === 'eu' ? 'api-eu.customer.io' : 'api.customer.io';
    for (let i = 0; i < 500; i++) {
      const m = (await getDb().execute({
        sql: `UPDATE sms_messages SET status = 'sending' WHERE id = (SELECT id FROM sms_messages WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, args: []
      })).rows[0];
      if (!m) break;
      let status = 'sent', error = null, deliveryId = null;
      // Live check just before sending (Joy, 24 Nov 2026): one RT lookup per
      // text, inside the existing 1.2s gap, so there's no burst on RT. If the
      // educator changed since the rep picked them, the text is skipped.
      const live = await liveCheck(m);
      if (live.skip) {
        await getDb().execute({ sql: `UPDATE sms_messages SET status = 'skipped', error = ? WHERE id = ?`, args: [live.skip, m.id] });
        continue;
      }
      if (live.phone && live.phone !== m.phone) { m.phone = live.phone; await getDb().execute({ sql: 'UPDATE sms_messages SET phone = ? WHERE id = ?', args: [m.phone, m.id] }); }
      try {
        const r = await fetch(`https://${host}/v1/send/sms`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactional_message_id: m.sender === 'announcement' ? ANNOUNCE_TX : TX_MESSAGE, identifiers: { id: m.cio_id || m.educator_id }, to: m.phone, message_data: { body: m.body } })
        });
        const d = await r.json().catch(() => ({}));
        if (r.status === 429) { status = 'queued'; await new Promise(res => setTimeout(res, 5000)); }
        else if (!r.ok) { status = 'failed'; error = (d.meta && d.meta.error) || (d.errors && d.errors[0] && d.errors[0].detail) || `Customer.io ${r.status}`; }
        else deliveryId = d.delivery_id || null;
      } catch (e) { status = 'failed'; error = e.message; }
      await getDb().execute({
        sql: `UPDATE sms_messages SET status = ?, error = ?, cio_delivery_id = ?, sent_at = CASE WHEN ? = 'sent' THEN now() ELSE sent_at END WHERE id = ?`,
        args: [status, error, deliveryId, status, m.id]
      });
      await new Promise(res => setTimeout(res, 1200));
    }
  } catch (e) { console.error('SMS queue error:', e.message); }
  finally { draining = false; }
}
async function liveCheck(m) {
  if (m.recipient_type && m.recipient_type !== 'educator') return {}; // centres / any number: sent as picked
  let c;
  try { c = await require('./rtApiReportService').fetchById('candidates', m.educator_id); }
  catch (e) { return { note: 'RT lookup failed, sent on the data the rep saw' }; } // RT down: don't hold every text
  if (!c) return { skip: 'No longer in RT' };
  require('./rtCandidatesSyncService').upsertCandidates?.([c]).catch?.(() => {});
  if (c.isDeleted || c.isActive === false) return { skip: 'No longer active in RT' };
  const now = require('../routes/micropods').complianceForLive(c, new Date().toISOString().slice(0, 10));
  if ([4, 8].includes(Number(c.status))) return { skip: `Now "${now.status}" in RT` };
  if (m.snap_status && now.status && now.status !== m.snap_status) return { skip: `Status changed in RT: ${m.snap_status} → ${now.status}` };
  if (m.snap_compliant === true && !now.compliant) return { skip: 'No longer compliant in RT' };
  const phone = toE164(c.contactNo);
  if (!phone) return { skip: 'No valid mobile in RT any more' };
  return { phone };
}

// Picks up anything left queued (restart, or sends that waited for 8am).
function startWorker() {
  getDb().execute({ sql: "UPDATE sms_messages SET status = 'queued' WHERE status = 'sending'", args: [] }).catch(() => {});
  setInterval(() => { getDb().execute({ sql: "SELECT 1 FROM sms_messages WHERE status = 'queued' LIMIT 1", args: [] }).then(r => { if (r.rows.length) kick(); }).catch(() => {}); }, 60 * 1000);
}

// Reply from Customer.io's inbound automation webhook.
async function recordInbound({ customerId, from, body }) {
  const db = getDb();
  let id = customerId ? String(customerId) : null, name = null, type = 'educator';
  // A centre's texts go out under its RT contact's Customer.io id: map the
  // reply back to the centre most recently texted under that id.
  if (id) {
    const c = (await db.execute({ sql: `SELECT educator_id, educator_name FROM sms_messages WHERE cio_id = ? AND recipient_type IN ('centre','number') ORDER BY id DESC LIMIT 1`, args: [id] })).rows[0];
    if (c) { const t = (await db.execute({ sql: `SELECT recipient_type FROM sms_messages WHERE educator_id = ? ORDER BY id DESC LIMIT 1`, args: [c.educator_id] })).rows[0]; id = c.educator_id; name = c.educator_name; type = (t && t.recipient_type) || 'centre'; }
  }
  if (!id && from) {
    const last9 = String(from).replace(/\D/g, '').slice(-9);
    const r = (await db.execute({ sql: `SELECT educator_id, educator_name FROM sms_messages WHERE right(regexp_replace(phone,'\\D','','g'),9) = ? ORDER BY id DESC LIMIT 1`, args: [last9] })).rows[0];
    if (r) { id = r.educator_id; name = r.educator_name; }
  }
  if (!id) return null;
  if (!name && type === 'educator') {
    const c = (await db.execute({ sql: 'SELECT first_name, last_name FROM rt_candidates_cache WHERE user_id::text = ?', args: [id] })).rows[0];
    name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : null;
  }
  const row = (await db.execute({
    sql: `INSERT INTO sms_messages (educator_id, educator_name, phone, direction, body, segments, status, recipient_type) VALUES (?,?,?,'in',?,?, 'received', ?) RETURNING id`,
    args: [id, name, from || null, String(body || '').slice(0, 2000), segmentInfo(body).segments, type]
  })).rows[0];
  notifyReply(id, name, body).catch(e => console.error('[sms] reply Slack:', e.message));
  return row.id;
}

// Joy, 25 Nov 2026: every reply goes to the HeartBeat daily thread in #daily-check-in,
// tagging whoever last texted that person.
async function notifyReply(id, name, body) {
  const slack = require('./slackService');
  if (!slack.isConfigured()) return;
  const last = (await getDb().execute({ sql: `SELECT sent_by_email FROM sms_messages WHERE educator_id = ? AND direction = 'out' AND sent_by_email IS NOT NULL ORDER BY id DESC LIMIT 1`, args: [id] })).rows[0];
  const uid = last ? await slack.slackUserId(last.sent_by_email).catch(() => null) : null;
  const url = `${process.env.APP_URL || 'https://rawtalent-internal.app'}/?tab=texts`;
  const text = String(body || '').replace(/\s+/g, ' ').slice(0, 300);
  await slack.postToDailyThread(`💬 *SMS reply from ${name || 'unknown'}*${uid ? ` <@${uid}>` : ''}\n> ${text}\n<${url}|Open in HeartBeat Texts>`);
}

async function notifyApprover(batchId, user, count, text, note) {
  const url = `${process.env.APP_URL || 'https://rawtalent-internal.app'}/sms-approval/${batchId}`;
  const msg = `📱 *SMS approval needed*\n${user.name || user.email} wants to text *${count} people*${note ? ` (${note})` : ''}:\n> ${String(text).slice(0, 300)}\n<${url}|Review and approve>`;
  await require('./slackService').sendDmByEmail(APPROVER_EMAIL, msg);
}

// Sophia approves or rejects a whole batch.
async function decideBatch(batchId, user, approve) {
  if (!isApprover(user) && user.role !== 'super_admin') throw Object.assign(new Error('Only Sophia can approve SMS sends.'), { status: 403 });
  const db = getDb();
  const b = (await db.execute({ sql: `UPDATE sms_batches SET approval_status = ?, approved_by = ?, approved_at = now() WHERE id = ? AND approval_status = 'pending' RETURNING *`,
    args: [approve ? 'approved' : 'rejected', user.email, batchId] })).rows[0];
  if (!b) throw Object.assign(new Error('This send was already decided or does not exist.'), { status: 409 });
  await db.execute({ sql: `UPDATE sms_messages SET status = ?, error = ? WHERE batch_id = ? AND status = 'pending_approval'`,
    args: approve ? ['queued', null, batchId] : ['skipped', 'Not approved by ' + (user.name || user.email), batchId] });
  if (approve) kick();
  require('./slackService').sendDmByEmail(b.sent_by_email, approve
    ? `✅ Your SMS to ${b.recipient_count} people was approved by ${user.name || user.email} and is sending now.`
    : `❌ Your SMS to ${b.recipient_count} people was not approved by ${user.name || user.email}.`).catch(() => {});
  return b;
}

module.exports = { notifyReply, decideBatch, needsApproval, APPROVAL_OVER, isApprover, canAnnounce, announceReady: () => !!ANNOUNCE_TX, canSendTexts, segmentInfo, toE164, queueSend, recordInbound, startWorker, inboundSecret, segmentsSentToday, LIMITS, inSendWindow };
