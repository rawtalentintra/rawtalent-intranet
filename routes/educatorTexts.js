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
const isCentreId = id => /^(loc|client):/.test(String(id));

// Centres that can be texted: RT centre/location contact mobile, sent under the
// client's RT contact profile in Customer.io (primaryUserId, same as the email
// journeys). Landline-only centres are listed but can't be picked.
let centreCache = { at: 0, data: null };
let centreBuilding = null;
async function centreAudience() {
  if (centreCache.data) {
    if (Date.now() - centreCache.at >= 10 * 60 * 1000 && !centreBuilding)
      centreBuilding = centreAudienceFresh().catch(e => console.error('[sms] centres refresh', e.message)).finally(() => { centreBuilding = null; });
    return centreCache.data;
  }
  if (!centreBuilding) centreBuilding = centreAudienceFresh().finally(() => { centreBuilding = null; });
  return centreBuilding;
}
async function centreAudienceFresh() {
  const cm = require('./centres');
  const { centres, rawClients, bookings } = await cm.getCentresAndBookings();
  const lastByKey = await cm.getLastBookingDates(centres, bookings);
  const byClient = new Map(rawClients.map(c => [String(c.clientId), c]));
  // Joy, 25 Nov 2026: hide RT's test centres (set up by Yuvraj, the RT dev) from texting.
  const isTest = c => /yuvraj/i.test(`${c.contactName || ''} ${c.name || ''}`);
  const data = centres.filter(c => c.isActive && !isTest(c)).map(c => {
    const client = byClient.get(String(c.rtClientId));
    const phone = (c.allPhones || []).find(p => svc.toE164(p)) || c.contactNo || null;
    const last = lastByKey[c.centreKey] ? new Date(lastByKey[c.centreKey]) : null;
    const days = last ? (Date.now() - last.getTime()) / 864e5 : null;
    return { userId: c.centreKey, type: 'centre', name: c.name, contactName: c.contactName || null, phone, allPhones: c.allPhones || [],
      hasMobile: !!svc.toE164(phone) && !!(client && client.primaryUserId), cioId: client && client.primaryUserId ? String(client.primaryUserId) : null,
      suburb: c.suburb, state: require('../services/micropodService').normalizeStateToShort(c.state),
      lat: Number.isFinite(c.latitude) ? c.latitude : null, lng: Number.isFinite(c.longitude) ? c.longitude : null,
      lastBooking: last ? last.toISOString().slice(0, 10) : null,
      booking: days == null ? 'Never booked' : days <= 30 ? 'Booked in last 30 days' : days <= 120 ? 'Booked in last 4 months' : 'Dormant (4+ months)' };
  });
  centreCache = { at: Date.now(), data };
  return data;
}

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
    let centreList = [];
    if (req.query.type === 'centres') {
      centreList = (await centreAudience()).map(c => { const l = byId.get(c.userId); return { ...c, lastTextAt: l?.last_out || null, lastReplyAt: l?.last_in || null }; });
    }
    res.json({ educators: req.query.type === 'centres' ? [] : educators, recipients: centreList, centres: map.centres.map(c => ({ centreKey: c.centreKey, name: c.name, suburb: c.suburb, state: c.state, lat: c.lat, lng: c.lng })), generatedAt: map.generatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/usage', async (req, res) => {
  try {
    const used = await svc.segmentsSentToday(req.user.email);
    // Spend counter: segments sent (or waiting to send) x the per-segment rate.
    const sp = (await getDb().execute({
      sql: `WITH m AS (SELECT segments, sent_by_email, created_at AT TIME ZONE 'Australia/Melbourne' t FROM sms_messages
                       WHERE direction = 'out' AND status IN ('queued','sending','sent'))
            SELECT coalesce(sum(segments) FILTER (WHERE t >= date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne')),0) day_all,
                   coalesce(sum(segments) FILTER (WHERE t >= date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') AND sent_by_email = ?),0) day_me,
                   coalesce(sum(segments) FILTER (WHERE t >= date_trunc('month', now() AT TIME ZONE 'Australia/Melbourne')),0) month_all,
                   coalesce(sum(segments) FILTER (WHERE t >= date_trunc('month', now() AT TIME ZONE 'Australia/Melbourne') AND sent_by_email = ?),0) month_me
            FROM m`,
      args: [req.user.email, req.user.email]
    })).rows[0];
    const cost = n => +(Number(n) * svc.LIMITS.costPerSegmentAud).toFixed(2);
    const spend = { todayMine: cost(sp.day_me), todayTeam: cost(sp.day_all), monthMine: cost(sp.month_me), monthTeam: cost(sp.month_all) };
    res.json({ spend: svc.canAnnounce(req.user) ? spend : null, usedToday: used, dailyLimit: svc.LIMITS.dailySegmentsPerSender, maxRecipients: svc.LIMITS.maxRecipientsPerSend,
      cooldownHours: svc.LIMITS.cooldownHours, costPerSegmentAud: svc.LIMITS.costPerSegmentAud, inSendWindow: svc.inSendWindow(), canAnnounce: svc.canAnnounce(req.user), announceReady: svc.announceReady(), approvalOver: svc.APPROVAL_OVER, isApprover: svc.isApprover(req.user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/send', async (req, res) => {
  try {
    const ids = new Set((req.body.userIds || []).map(String));
    if (!ids.size) return res.status(400).json({ error: 'Pick at least one educator' });
    const map = await educatorMap();
    const recipients = map.educators.filter(e => ids.has(e.userId)).map(e => ({ userId: e.userId, name: e.name, phone: e.phone, status: e.status, compliant: e.compliant, type: 'educator' }));
    if ([...ids].some(isCentreId)) {
      for (const c of await centreAudience()) {
        if (!ids.has(c.userId)) continue;
        if (!c.cioId) { continue; }
        recipients.push({ userId: c.userId, name: c.name, firstName: (c.contactName || '').split(' ')[0] || 'there', phone: (c.allPhones || []).find(p => svc.toE164(p)) || c.phone, type: 'centre', cioId: c.cioId });
      }
    }
    // Any number (Joy, 24 Nov 2026): ids "tel:+61…". If the number already
    // belongs to an RT educator or centre, it's sent as them (so replies land in
    // their conversation); otherwise under a Customer.io profile "sms_61…".
    const names = req.body.numberNames || {};
    const telIds = [...ids].filter(id => String(id).startsWith('tel:'));
    if (telIds.length) {
      const centresList = await centreAudience();
      for (const id of telIds) {
        const e164 = svc.toE164(id.slice(4));
        if (!e164) { recipients.push({ userId: id, name: names[id] || id.slice(4), phone: null, type: 'number' }); continue; }
        const last9 = e164.slice(-9), same = p => String(p || '').replace(/\D/g, '').slice(-9) === last9;
        const ed = map.educators.find(e => same(e.phone));
        if (ed) { if (!recipients.some(r => r.userId === ed.userId)) recipients.push({ userId: ed.userId, name: ed.name, phone: ed.phone, status: ed.status, compliant: ed.compliant, type: 'educator' }); continue; }
        const ce = centresList.find(c => c.cioId && (c.allPhones || []).some(same));
        if (ce) { if (!recipients.some(r => r.userId === ce.userId)) recipients.push({ userId: ce.userId, name: ce.name, firstName: (ce.contactName || '').split(' ')[0] || 'there', phone: e164, type: 'centre', cioId: ce.cioId }); continue; }
        const nm = String(names[id] || '').trim();
        recipients.push({ userId: 'tel:' + e164, name: nm || e164, firstName: nm ? nm.split(/\s+/)[0] : 'there', phone: e164, type: 'number', cioId: 'sms_' + e164.slice(1) });
      }
    }
    // Every new send must be tagged Booking or Onboarding (Joy, 25 Nov 2026); replies keep the conversation's tag.
    if (req.body.audienceNote !== 'Reply' && !TAGS.includes(req.body.tag)) return res.status(400).json({ error: 'Tag this text as Booking or Onboarding before sending' });
    // Group texts need a title so the Inbox can filter to everyone who got it.
    const title = String(req.body.title || '').trim();
    if (req.body.audienceNote !== 'Reply' && ids.size > 1 && !title) return res.status(400).json({ error: 'Give this group text a title (e.g. 25-Nov Strat) so you can find it in the Inbox' });
    const out = await svc.queueSend({ recipients, body: req.body.body, user: req.user, audienceNote: req.body.audienceNote, ignoreCooldown: !!req.body.ignoreCooldown && ids.size === 1, sender: req.body.sender === 'announcement' ? 'announcement' : 'number', tag: TAGS.includes(req.body.tag) ? req.body.tag : null, title: title || null });
    res.json(out);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Live re-check (same as the Educator Map): the browser sends the ids on
// screen (max 60); each is fetched from RT by id so status/compliance are current.
router.post('/live', async (req, res) => {
  try {
    const ids = [...new Set((req.body?.ids || []).map(String).filter(x => /^\d+$/.test(x)))].slice(0, 60);
    if (!ids.length) return res.json({ educators: [] });
    const { candidates } = await require('../services/rtCandidatesSyncService').fetchCandidatesLive(ids, { concurrency: 8 });
    const today = new Date().toISOString().slice(0, 10), mp = require('./micropods');
    res.json({ educators: candidates.map(c => ({ userId: String(c.userId), phone: c.contactNo || null, ...mp.complianceForLive(c, today) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Inbox: one row per educator, newest first.
router.get('/conversations', async (req, res) => {
  try {
    const rows = (await getDb().execute({
      // ?date=YYYY-MM-DD keeps only conversations with a message that day (Melbourne).
      sql: `SELECT DISTINCT ON (educator_id) educator_id, educator_name, direction, body, status, created_at, recipient_type,
              (SELECT max(phone) FROM sms_messages p WHERE p.educator_id = m.educator_id) phone,
              (SELECT count(*) FROM sms_messages u WHERE u.educator_id = m.educator_id AND u.direction='in' AND u.read_at IS NULL) unread,
              (SELECT tag FROM sms_tags t WHERE t.educator_id = m.educator_id) tag
            FROM sms_messages m
            WHERE true
            ${/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? `AND educator_id IN (SELECT educator_id FROM sms_messages WHERE (created_at AT TIME ZONE 'Australia/Melbourne')::date = ?::date)` : ''}
            ${/^\d+$/.test(req.query.batch || '') ? `AND educator_id IN (SELECT educator_id FROM sms_messages WHERE batch_id = ?)` : ''}
            ORDER BY educator_id, id DESC`,
      args: [...(/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? [req.query.date] : []), ...(/^\d+$/.test(req.query.batch || '') ? [Number(req.query.batch)] : [])]
    })).rows.sort((a, b) => (Number(b.unread) > 0) - (Number(a.unread) > 0) || new Date(b.created_at) - new Date(a.created_at)).slice(0, 500);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    const db = getDb();
    const msgs = (await db.execute({ sql: `SELECT id, direction, body, status, error, segments, sent_by_name, sender, created_at, sent_at FROM sms_messages WHERE educator_id = ? ORDER BY id DESC LIMIT 200`, args: [req.params.id] })).rows.reverse();
    await db.execute({ sql: `UPDATE sms_messages SET read_at = now() WHERE educator_id = ? AND direction = 'in' AND read_at IS NULL`, args: [req.params.id] });
    res.json(msgs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cheap poll for the open page: anything newer than the last id it has.
// Titled group texts, newest first, for the Inbox filter.
router.get('/batches', async (req, res) => {
  try {
    res.json((await getDb().execute({ sql: `SELECT id, title, tag, sent_by_name, recipient_count, created_at FROM sms_batches WHERE title IS NOT NULL ORDER BY id DESC LIMIT 200`, args: [] })).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tags (Booking / Onboarding) ──
const TAGS = ['Booking', 'Onboarding'];
router.put('/conversations/:id/tag', async (req, res) => {
  try {
    const tag = TAGS.includes(req.body.tag) ? req.body.tag : null;
    if (tag) await getDb().execute({ sql: `INSERT INTO sms_tags (educator_id, tag, tagged_by, tagged_at) VALUES (?,?,?,now())
      ON CONFLICT (educator_id) DO UPDATE SET tag = excluded.tag, tagged_by = excluded.tagged_by, tagged_at = now()`, args: [req.params.id, tag, req.user.email] });
    else await getDb().execute({ sql: 'DELETE FROM sms_tags WHERE educator_id = ?', args: [req.params.id] });
    res.json({ ok: true, tag });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Saved groups (shared with the team) ──
router.get('/groups', async (req, res) => {
  try { res.json((await getDb().execute({ sql: 'SELECT id, name, kind, member_ids, created_by, updated_at FROM sms_groups ORDER BY lower(name)', args: [] })).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/groups', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80), ids = [...new Set((req.body.memberIds || []).map(String))].slice(0, 2000);
    if (!name || !ids.length) return res.status(400).json({ error: 'Give the group a name and pick at least one person' });
    res.json((await getDb().execute({ sql: `INSERT INTO sms_groups (name, kind, member_ids, created_by) VALUES (?,?,?::jsonb,?) RETURNING *`,
      args: [name, req.body.kind === 'centres' ? 'centres' : 'educators', JSON.stringify(ids), req.user.email] })).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/groups/:id', async (req, res) => {
  try {
    const name = req.body.name != null ? String(req.body.name).trim().slice(0, 80) : null;
    const ids = Array.isArray(req.body.memberIds) ? JSON.stringify([...new Set(req.body.memberIds.map(String))].slice(0, 2000)) : null;
    const r = (await getDb().execute({ sql: `UPDATE sms_groups SET name = COALESCE(NULLIF(?,''), name), member_ids = COALESCE(?::jsonb, member_ids), updated_at = now() WHERE id = ? RETURNING *`,
      args: [name, ids, Number(req.params.id)] })).rows[0];
    r ? res.json(r) : res.status(404).json({ error: 'Group not found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/groups/:id', async (req, res) => {
  try { await getDb().execute({ sql: 'DELETE FROM sms_groups WHERE id = ?', args: [Number(req.params.id)] }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Templates (shared with the team) ──
router.get('/templates', async (req, res) => {
  try { res.json((await getDb().execute({ sql: 'SELECT id, name, body, created_by, updated_at FROM sms_templates ORDER BY lower(name)', args: [] })).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/templates', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80), body = String(req.body.body || '').trim().slice(0, 1600);
    if (!name || !body) return res.status(400).json({ error: 'A template needs a name and a message' });
    res.json((await getDb().execute({ sql: 'INSERT INTO sms_templates (name, body, created_by) VALUES (?,?,?) RETURNING *', args: [name, body, req.user.email] })).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/templates/:id', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80), body = String(req.body.body || '').trim().slice(0, 1600);
    if (!name || !body) return res.status(400).json({ error: 'A template needs a name and a message' });
    const r = (await getDb().execute({ sql: 'UPDATE sms_templates SET name = ?, body = ?, updated_at = now() WHERE id = ? RETURNING *', args: [name, body, Number(req.params.id)] })).rows[0];
    r ? res.json(r) : res.status(404).json({ error: 'Template not found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/templates/:id', async (req, res) => {
  try { await getDb().execute({ sql: 'DELETE FROM sms_templates WHERE id = ?', args: [Number(req.params.id)] }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Manual refresh (Joy, 25 Nov 2026): pull RT candidates + bookings now so the
// list's status/onboarding/compliance/engagement are current before a send.
// One refresh at a time for everyone; RT's own sync lock prevents overlap with
// the scheduled syncs; a refresh within 5 minutes of the last one is skipped.
const refreshJob = { running: false, step: null, startedAt: null, finishedAt: null, error: null, by: null };
// Also reports a scheduled RT sync in progress, so everyone's button greys out.
router.get('/refresh', async (req, res) => {
  let rtSync = false;
  try { const sync = require('../services/rtCandidatesSyncService'); rtSync = sync.isSyncRunning(await sync.getSyncState()); } catch {}
  res.json({ ...refreshJob, running: refreshJob.running || rtSync, step: refreshJob.step || (rtSync ? 'RT sync already running' : null) });
});
router.post('/refresh', async (req, res) => {
  if (refreshJob.running) return res.status(409).json({ ...refreshJob, alreadyRunning: true, error: `Already refreshing (started by ${refreshJob.by || 'someone'}). Please wait.` });
  if (refreshJob.finishedAt && !refreshJob.error && Date.now() - refreshJob.finishedAt < 5 * 60 * 1000) return res.json({ ...refreshJob, recent: true });
  // Fast + exact (Joy, 25 Nov 2026): re-fetch only the educators in the sender's
  // current filtered list, one by one from RT's by-id endpoint, instead of
  // pulling all ~15,000. The 2-hourly RT sync still picks up brand-new sign-ups.
  const ids = [...new Set((req.body.ids || []).map(String).filter(id => /^\d+$/.test(id)))].slice(0, 1000);
  Object.assign(refreshJob, { running: true, step: ids.length ? `Checking ${ids.length} educators in RT` : 'Pulling bookings from RT', startedAt: Date.now(), finishedAt: null, error: null, by: req.user.name || req.user.email, count: ids.length, failed: 0 });
  res.json(refreshJob);
  (async () => {
    const sync = require('../services/rtCandidatesSyncService');
    if (ids.length) {
      const { failed } = await sync.fetchCandidatesLive(ids, { concurrency: 8, onProgress: (d, n) => { refreshJob.step = `Checking educators in RT (${d}/${n})`; } });
      refreshJob.failed = failed.length;
    }
    refreshJob.step = 'Pulling bookings from RT';
    await require('./centres').refreshCentresAndBookings();
    refreshJob.step = 'Rebuilding the list';
    await require('./micropods').rebuildEducatorMap();
    centreCache = { at: 0, data: null };
    await centreAudience();
  })().then(() => { Object.assign(refreshJob, { running: false, step: null, finishedAt: Date.now() }); })
    .catch(err => { console.error('[sms] refresh failed:', err.message); Object.assign(refreshJob, { running: false, step: null, finishedAt: Date.now(), error: err.message }); });
});

router.get('/updates', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const r = (await getDb().execute({ sql: `SELECT max(id) maxid, count(*) FILTER (WHERE direction='in' AND read_at IS NULL) unread, count(*) FILTER (WHERE id > ?) newer FROM sms_messages`, args: [since] })).rows[0];
    const st = (await getDb().execute({ sql: `SELECT max(id) FILTER (WHERE status IN ('sent','failed','skipped')) settled FROM sms_messages`, args: [] })).rows[0];
    res.json({ maxId: Number(r.maxid) || 0, unread: Number(r.unread) || 0, changed: Number(r.newer) > 0, settled: Number(st.settled) || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Setup info for Customer.io's reply webhook (super admin only).
router.get('/setup', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(404).json({ error: 'Not found' });
  res.json({ inboundWebhookUrl: `${req.protocol}://${req.get('host')}/api/public/sms-inbound/${svc.inboundSecret()}` });
});

module.exports = router;
