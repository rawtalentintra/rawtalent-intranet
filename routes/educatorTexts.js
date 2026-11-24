// Educator Texts API (Joy, 24 Nov 2026). See services/educatorTextService.js.
// Super admin only for now; reps get it later through users.can_send_texts.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const svc = require('../services/educatorTextService');

router.use((req, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (!svc.canSendTexts(req.user)) return res.status(404).json({ error: 'Not found' });
  next();
});

const educatorMap = () => require('./micropods').buildEducatorMap();

// Everyone the filters can pick from (same list and RT accuracy as the
// Educator Map), plus when each was last texted / last replied.
router.get('/audience', async (req, res) => {
  try {
    const [map, last] = await Promise.all([educatorMap(), getDb().execute({
      sql: `SELECT educator_id, max(created_at) FILTER (WHERE direction='out') last_out, max(created_at) FILTER (WHERE direction='in') last_in
            FROM sms_messages GROUP BY educator_id`, args: []
    })]);
    const byId = new Map(last.rows.map(r => [r.educator_id, r]));
    const educators = map.educators.map(e => {
      const l = byId.get(e.userId);
      return { userId: e.userId, name: e.name, phone: e.phone, hasMobile: !!svc.toE164(e.phone), suburb: e.suburb, state: e.state, lat: e.lat, lng: e.lng,
        status: e.status, onboarding: e.onboarding, compliant: e.compliant, gender: e.gender, qualification: e.qualification,
        segment: e.segment, shifts28d: e.shifts28d, availDays: e.availDays || 0, lastShift: e.lastShift,
        lastTextAt: l?.last_out || null, lastReplyAt: l?.last_in || null };
    });
    res.json({ educators, centres: map.centres.map(c => ({ centreKey: c.centreKey, name: c.name, suburb: c.suburb, state: c.state, lat: c.lat, lng: c.lng })), generatedAt: map.generatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/usage', async (req, res) => {
  try {
    const used = await svc.segmentsSentToday(req.user.email);
    res.json({ usedToday: used, dailyLimit: svc.LIMITS.dailySegmentsPerSender, maxRecipients: svc.LIMITS.maxRecipientsPerSend,
      cooldownHours: svc.LIMITS.cooldownHours, costPerSegmentAud: svc.LIMITS.costPerSegmentAud, inSendWindow: svc.inSendWindow() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/send', async (req, res) => {
  try {
    const ids = new Set((req.body.userIds || []).map(String));
    if (!ids.size) return res.status(400).json({ error: 'Pick at least one educator' });
    const map = await educatorMap();
    const recipients = map.educators.filter(e => ids.has(e.userId)).map(e => ({ userId: e.userId, name: e.name, phone: e.phone }));
    const out = await svc.queueSend({ recipients, body: req.body.body, user: req.user, audienceNote: req.body.audienceNote, ignoreCooldown: !!req.body.ignoreCooldown && ids.size === 1 });
    res.json(out);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Inbox: one row per educator, newest first.
router.get('/conversations', async (req, res) => {
  try {
    const rows = (await getDb().execute({
      sql: `SELECT DISTINCT ON (educator_id) educator_id, educator_name, direction, body, status, created_at,
              (SELECT count(*) FROM sms_messages u WHERE u.educator_id = m.educator_id AND u.direction='in' AND u.read_at IS NULL) unread
            FROM sms_messages m WHERE status <> 'skipped' ORDER BY educator_id, id DESC`, args: []
    })).rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 300);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    const db = getDb();
    const msgs = (await db.execute({ sql: `SELECT id, direction, body, status, error, segments, sent_by_name, created_at, sent_at FROM sms_messages WHERE educator_id = ? ORDER BY id DESC LIMIT 200`, args: [req.params.id] })).rows.reverse();
    await db.execute({ sql: `UPDATE sms_messages SET read_at = now() WHERE educator_id = ? AND direction = 'in' AND read_at IS NULL`, args: [req.params.id] });
    res.json(msgs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cheap poll for the open page: anything newer than the last id it has.
router.get('/updates', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const r = (await getDb().execute({ sql: `SELECT max(id) maxid, count(*) FILTER (WHERE direction='in' AND read_at IS NULL) unread, count(*) FILTER (WHERE id > ?) newer FROM sms_messages`, args: [since] })).rows[0];
    const st = (await getDb().execute({ sql: `SELECT max(id) FILTER (WHERE status IN ('sent','failed')) settled FROM sms_messages`, args: [] })).rows[0];
    res.json({ maxId: Number(r.maxid) || 0, unread: Number(r.unread) || 0, changed: Number(r.newer) > 0, settled: Number(st.settled) || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Setup info for Customer.io's reply webhook (super admin only).
router.get('/setup', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(404).json({ error: 'Not found' });
  res.json({ inboundWebhookUrl: `${req.protocol}://${req.get('host')}/api/public/sms-inbound/${svc.inboundSecret()}` });
});

module.exports = router;
