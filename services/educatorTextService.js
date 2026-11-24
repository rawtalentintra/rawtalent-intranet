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
//  - sends only go out 8am to 8pm Melbourne time; anything later waits
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
  sendFromHour: 8, sendToHour: 20
};

function canSendTexts(user) {
  return !!user && (user.role === 'super_admin' || !!user.can_send_texts);
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
    sql: `SELECT coalesce(sum(segments),0) n FROM sms_messages WHERE direction = 'out' AND sent_by_email = ? AND status IN ('queued','sent')
            AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') AT TIME ZONE 'Australia/Melbourne')`,
    args: [email]
  })).rows[0];
  return Number(r.n) || 0;
}

// recipients: [{ userId, name, phone }] from the server-side educator list.
async function queueSend({ recipients, body, user, audienceNote, ignoreCooldown = false }) {
  const text = smart(body).trim();
  if (!text) throw Object.assign(new Error('Write a message first'), { status: 400 });
  if (text.length > 600) throw Object.assign(new Error('Keep texts under 600 characters'), { status: 400 });
  if (recipients.length > LIMITS.maxRecipientsPerSend) throw Object.assign(new Error(`One send can go to at most ${LIMITS.maxRecipientsPerSend} educators. Narrow the filters.`), { status: 400 });
  // {first_name} is filled per educator; cost is based on the longest result.
  const first = r => (String(r.name || '').trim().split(/\s+/)[0] || 'there');
  const render = r => text.replace(/\{first_name\}/gi, first(r));
  const seg = recipients.length ? recipients.map(r => segmentInfo(render(r))).sort((a, b) => b.segments - a.segments)[0] : segmentInfo(text);
  const db = getDb();

  const skipped = [];
  const ids = recipients.map(r => String(r.userId));
  // Cool-down: last outbound in the window, unless they've replied since.
  const recent = ids.length ? (await db.execute({
    sql: `SELECT educator_id, max(created_at) FILTER (WHERE direction='out' AND status IN ('queued','sent')) last_out,
                 max(created_at) FILTER (WHERE direction='in') last_in
          FROM sms_messages WHERE educator_id = ANY(?) AND created_at > now() - make_interval(hours => ?) GROUP BY educator_id`,
    args: [ids, LIMITS.cooldownHours]
  })).rows : [];
  const blocked = new Set(recent.filter(r => r.last_out && !(r.last_in && r.last_in > r.last_out)).map(r => r.educator_id));

  const ok = [];
  for (const r of recipients) {
    const phone = toE164(r.phone);
    if (!phone) { skipped.push({ ...r, why: 'No valid mobile number' }); continue; }
    if (!ignoreCooldown && blocked.has(String(r.userId))) { skipped.push({ ...r, why: `Texted in the last ${LIMITS.cooldownHours} hours` }); continue; }
    ok.push({ ...r, phone });
  }
  const need = ok.length * seg.segments;
  const used = await segmentsSentToday(user.email);
  if (used + need > LIMITS.dailySegmentsPerSender) {
    throw Object.assign(new Error(`That's ${need} SMS segments, and you have ${Math.max(0, LIMITS.dailySegmentsPerSender - used)} left today (daily limit ${LIMITS.dailySegmentsPerSender}).`), { status: 429 });
  }
  if (!ok.length) return { queued: 0, skipped, segments: seg.segments, estCostAud: 0 };

  const batch = (await db.execute({
    sql: `INSERT INTO sms_batches (sent_by_email, sent_by_name, body, audience_note, recipient_count, segments_per_message) VALUES (?,?,?,?,?,?) RETURNING id`,
    args: [user.email, user.name || user.email, text, audienceNote || null, ok.length, seg.segments]
  })).rows[0];
  for (const r of ok) {
    await db.execute({
      sql: `INSERT INTO sms_messages (educator_id, educator_name, phone, direction, body, segments, status, batch_id, sent_by_email, sent_by_name)
            VALUES (?,?,?,'out',?,?,'queued',?,?,?)`,
      args: [String(r.userId), r.name || null, r.phone, render(r), segmentInfo(render(r)).segments, batch.id, user.email, user.name || user.email]
    });
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
      try {
        const r = await fetch(`https://${host}/v1/send/sms`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactional_message_id: TX_MESSAGE, identifiers: { id: m.educator_id }, to: m.phone, message_data: { body: m.body } })
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
// Picks up anything left queued (restart, or sends that waited for 8am).
function startWorker() {
  getDb().execute({ sql: "UPDATE sms_messages SET status = 'queued' WHERE status = 'sending'", args: [] }).catch(() => {});
  setInterval(() => { getDb().execute({ sql: "SELECT 1 FROM sms_messages WHERE status = 'queued' LIMIT 1", args: [] }).then(r => { if (r.rows.length) kick(); }).catch(() => {}); }, 60 * 1000);
}

// Reply from Customer.io's inbound automation webhook.
async function recordInbound({ customerId, from, body }) {
  const db = getDb();
  let id = customerId ? String(customerId) : null, name = null;
  if (!id && from) {
    const last9 = String(from).replace(/\D/g, '').slice(-9);
    const r = (await db.execute({ sql: `SELECT educator_id, educator_name FROM sms_messages WHERE right(regexp_replace(phone,'\\D','','g'),9) = ? ORDER BY id DESC LIMIT 1`, args: [last9] })).rows[0];
    if (r) { id = r.educator_id; name = r.educator_name; }
  }
  if (!id) return null;
  if (!name) {
    const c = (await db.execute({ sql: 'SELECT first_name, last_name FROM rt_candidates_cache WHERE user_id::text = ?', args: [id] })).rows[0];
    name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : null;
  }
  const row = (await db.execute({
    sql: `INSERT INTO sms_messages (educator_id, educator_name, phone, direction, body, segments, status) VALUES (?,?,?,'in',?,?, 'received') RETURNING id`,
    args: [id, name, from || null, String(body || '').slice(0, 2000), segmentInfo(body).segments]
  })).rows[0];
  return row.id;
}

module.exports = { canSendTexts, segmentInfo, toE164, queueSend, recordInbound, startWorker, inboundSecret, segmentsSentToday, LIMITS, inSendWindow };
