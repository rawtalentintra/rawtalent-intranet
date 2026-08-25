const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { BUCKETS, uploadBuffer, downloadAsBuffer, remove: removeFile, extForMimetype, ensureBucket } = require('../services/storageService');
const leave = require('../services/leaveService');

const announcementFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const TIMESHEET_TZ = 'Australia/Melbourne'; // same convention as routes/calls.js's MELBOURNE_TZ

router.use(requireAuth);

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Reminder text shown to admins for an upcoming date — the "action plan"
// is deliberately random each time so it doesn't go stale/ignorable.
const BIRTHDAY_ACTIONS = [
  'Make them feel appreciated by preparing something special!',
  "Don't forget to greet them before the day is over!",
  'Give them a shoutout in the team chat!',
  'A small treat or card goes a long way — maybe surprise them?',
  'Rally the team for a quick birthday cheer!',
  'Take a moment to make their day extra special!'
];
const ANNIVERSARY_ACTIONS = [
  'Make them feel appreciated by preparing something special!',
  "Don't forget to greet them!",
  'Take a moment to thank them for another great year with the team!',
  'A little recognition goes a long way — celebrate their milestone!',
  'Consider a shoutout in the team chat for their hard work!',
  'Let them know how much their contribution means to the team!'
];

// The actual greeting message a recipient sees when someone sends them one —
// picked at random so repeat greetings from different people don't feel
// copy-pasted.
const BIRTHDAY_GREETING_MESSAGES = [
  "🎂🎉 Happy Birthday! Hope your day is filled with cake, laughter, and all your favourite things!",
  "🥳🎈 Wishing you the happiest of birthdays! Thanks for being such an awesome part of the team!",
  "🎉🎁 Happy Birthday! May this year bring you even more reasons to smile!",
  "🎂✨ Sending you birthday wishes and a big virtual hug! Have a wonderful day!",
  "🎊🎂 Happy Birthday! Take today to celebrate YOU — you deserve it!"
];
const ANNIVERSARY_GREETING_MESSAGES = [
  "🎉🏆 Happy Work Anniversary! Thank you for another incredible year with the team!",
  "🎊👏 Congrats on your work anniversary! Your hard work truly makes a difference!",
  "🥳💼 Happy Anniversary! Here's to many more great years together!",
  "🎉🌟 Celebrating you today! Thanks for all you do for the team!",
  "🏆🎊 Happy Work Anniversary! Grateful to have you on the team!"
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Generates a fresh, one-off greeting via Claude so repeat greetings (there's
// no limit on how many people can send) don't all read the same — falls back
// to the static pool above if AI isn't configured or the call fails.
async function generateGreetingMessage(type, recipientName) {
  const client = getClient();
  if (!client) return pick(type === 'birthday' ? BIRTHDAY_GREETING_MESSAGES : ANNIVERSARY_GREETING_MESSAGES);
  try {
    const occasion = type === 'birthday' ? 'birthday' : 'work anniversary';
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: `You write short, warm, genuinely fun workplace greeting messages for RawTalent, a friendly Australian childcare staffing agency. One or two sentences, upbeat and casual (never corporate or generic), with 2-3 well-placed emoji. Write in Australian English (e.g. "celebrate", "favourite", "organise") — never American spelling. Respond with ONLY the message text, nothing else.`,
      messages: [{ role: 'user', content: `Write a ${occasion} greeting for a teammate named ${recipientName}.` }]
    });
    const textBlock = response.content.find(b => b.type === 'text');
    const text = textBlock?.text?.trim();
    return text || pick(type === 'birthday' ? BIRTHDAY_GREETING_MESSAGES : ANNIVERSARY_GREETING_MESSAGES);
  } catch {
    return pick(type === 'birthday' ? BIRTHDAY_GREETING_MESSAGES : ANNIVERSARY_GREETING_MESSAGES);
  }
}

// Computes the next occurrence (this year or next) of a "Month DD, YYYY"
// style date string, and how many days from today that is.
function nextOccurrence(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
  next.setHours(0, 0, 0, 0);
  if (next < today) next.setFullYear(next.getFullYear() + 1);
  const daysUntil = Math.round((next - today) / 86400000);
  return { daysUntil, date: ymd(next) };
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Reminders fire a week before, 2 days before, 1 day before, and on the day
// itself — not a full rolling window (so the panel doesn't stay cluttered
// all week), but enough that a 1-day gap doesn't leave everyone with nothing
// to act on the day before something like a work anniversary, and the
// 7-day heads-up gives people enough notice to actually plan something.
const REMINDER_DAYS_BEFORE = [0, 1, 2, 7];

router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const teamRes = await db.execute('SELECT id, name, email, birthdate, employment_date FROM team_members');
    const me = teamRes.rows.find(m => m.email && req.user.email && m.email.toLowerCase() === req.user.email.toLowerCase());

    // "Your Greetings" — visible to everyone, not just admins.
    let receivedGreetings = [];
    if (me) {
      const gRes = await db.execute({
        sql: 'SELECT * FROM team_greetings WHERE team_member_id = ? ORDER BY created_at DESC LIMIT 30',
        args: [me.id]
      });
      receivedGreetings = gRes.rows;
    }

    // "Upcoming" reminders — every signed-in user, so anyone can send a
    // birthday/anniversary greeting, not just admins. (Previously
    // admin/super_admin only, which silently meant most of the team never
    // saw these reminders at all and couldn't send greetings.)
    let upcomingEvents = [];
    {
      // A reminder counts as "already handled" (and stops being unread) once
      // *this* person has personally sent that person a greeting of that
      // type recently — recently, not ever, so it naturally resets for next
      // year's occurrence instead of being permanently silenced.
      const recentRes = await db.execute({
        sql: `SELECT team_member_id, greeting_type FROM team_greetings
              WHERE sent_by_email = ? AND created_at > now() - interval '5 days'`,
        args: [req.user.email]
      });
      const recentlySent = new Set(recentRes.rows.map(r => `${r.team_member_id}:${r.greeting_type}`));

      for (const m of teamRes.rows) {
        // Skip your own reminder — nobody needs to be prompted to send
        // themselves a birthday greeting.
        if (m.email && req.user.email && m.email.toLowerCase() === req.user.email.toLowerCase()) continue;
        const bday = nextOccurrence(m.birthdate);
        if (bday && REMINDER_DAYS_BEFORE.includes(bday.daysUntil)) {
          upcomingEvents.push({
            teamMemberId: m.id, name: m.name, type: 'birthday', daysUntil: bday.daysUntil, date: bday.date,
            headline: bday.daysUntil === 0 ? `It's ${m.name}'s Birthday today! 🎂` : `It's almost ${m.name}'s Birthday! 🎂`,
            action: pick(BIRTHDAY_ACTIONS),
            alreadySent: recentlySent.has(`${m.id}:birthday`)
          });
        }
        const anniv = nextOccurrence(m.employment_date);
        if (anniv && REMINDER_DAYS_BEFORE.includes(anniv.daysUntil)) {
          upcomingEvents.push({
            teamMemberId: m.id, name: m.name, type: 'anniversary', daysUntil: anniv.daysUntil, date: anniv.date,
            headline: anniv.daysUntil === 0 ? `It's ${m.name}'s Employment Date Anniversary today! 🎉` : `It's almost ${m.name}'s Employment Date Anniversary! 🎉`,
            action: pick(ANNIVERSARY_ACTIONS),
            alreadySent: recentlySent.has(`${m.id}:anniversary`)
          });
        }
      }
      upcomingEvents.sort((a, b) => a.daysUntil - b.daysUntil);
    }

    // Announcements — visible to everyone once send_at has passed. A row
    // scheduled for the future simply doesn't show up yet. is_read here
    // (bell/badge visibility) is genuinely acknowledged OR merely dismissed
    // from the bell via "Mark all read" — dismissal never touches
    // announcement_reads, so the Announcements tab's compliance tracking
    // (who has actually ticked "I have read and understood this") is
    // unaffected by clearing the bell badge.
    // Once someone actually ticks "I have read and understood" on the
    // Announcements tab, it drops out of the bell entirely — not just
    // greyed out. A bell-only "Mark all read" dismissal (no real ack) still
    // leaves the row in this list, just no longer counted unread, so it
    // stays discoverable until genuinely acknowledged.
    const annRes = await db.execute({
      sql: `SELECT a.*, (d.user_email IS NOT NULL) AS is_read
            FROM announcements a
            LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_email = ?
            LEFT JOIN notification_dismissals d ON d.notification_key = 'announcement:' || a.id AND d.user_email = ?
            WHERE a.send_at <= now() AND r.user_email IS NULL
            ORDER BY a.send_at DESC LIMIT 30`,
      args: [req.user.email, req.user.email]
    });
    const announcements = annRes.rows;

    // Training assigned to me — stays in the bell as a standing reminder
    // until I actually complete it (no separate read/unread state; a
    // pending assignment is inherently "unread" every time).
    const assignRes = await db.execute({
      sql: `SELECT ta.id, ta.course_id, ta.due_date, ta.assigned_by_name, tc.title AS course_title,
                   att.status AS attempt_status
            FROM training_assignments ta
            JOIN training_courses tc ON tc.id = ta.course_id
            LEFT JOIN LATERAL (
              SELECT status FROM training_attempts
              WHERE course_id = ta.course_id AND user_email = ta.user_email
              ORDER BY started_at DESC LIMIT 1
            ) att ON true
            WHERE ta.user_email = ?
            ORDER BY ta.due_date ASC NULLS LAST, ta.created_at DESC`,
      args: [req.user.email]
    });
    const trainingAssignments = assignRes.rows.filter(a => a.attempt_status !== 'completed');

    // Leave requests awaiting MY decision (as level-1 manager or a final
    // approver) — a required action, so this stays in the bell (like
    // training assignments) until actually approved/rejected, never cleared
    // by "Mark all read".
    const leaveApprovals = await leave.listPendingFor(req.user.email);

    // My own requests that were decided — informational, so these dismiss
    // via notification_dismissals same as announcements.
    const myDecidedRes = await db.execute({
      sql: `SELECT lr.*, (d.user_email IS NOT NULL) AS is_read
            FROM leave_requests lr
            LEFT JOIN notification_dismissals d ON d.notification_key = 'leave:' || lr.id AND d.user_email = ?
            WHERE LOWER(lr.user_email) = LOWER(?) AND lr.status IN ('approved', 'rejected')
            ORDER BY lr.updated_at DESC LIMIT 30`,
      args: [req.user.email, req.user.email]
    });
    const leaveDecisions = myDecidedRes.rows;

    // Article-feedback suggestions I submitted that an admin has since
    // marked Done — informational, dismissed via notification_dismissals
    // same as leave decisions/announcements. This is the whole point of
    // wiring feedback into the bell: the submitter previously had no way to
    // ever find out their suggestion was seen, let alone acted on.
    const myFeedbackRes = await db.execute({
      sql: `SELECT f.*, (d.user_email IS NOT NULL) AS is_read
            FROM feedback f
            LEFT JOIN notification_dismissals d ON d.notification_key = 'feedback:' || f.id AND d.user_email = ?
            WHERE LOWER(f.submitted_by) = LOWER(?) AND f.status = 'done'
            ORDER BY f.updated_at DESC LIMIT 30`,
      args: [req.user.email, req.user.email]
    });
    const feedbackDecisions = myFeedbackRes.rows;

    // Tasks assigned to me that are due within 2 days or already overdue —
    // a required action, so (like training assignments) this stays in the
    // bell until the task is actually marked done or reassigned, never
    // cleared by "Mark all read".
    const taskAlertsRes = await db.execute({
      sql: `SELECT t.*, tc.name AS classification_name, td.name AS department_name, td.color AS department_color
            FROM tasks t
            LEFT JOIN task_classifications tc ON tc.id = t.classification_id
            LEFT JOIN task_departments td ON td.id = t.department_id
            WHERE t.assigned_to_emails @> to_jsonb(LOWER(?)::text) AND t.status != 'done'
              AND t.due_date IS NOT NULL AND t.due_date <= (CURRENT_DATE + INTERVAL '2 days')
            ORDER BY t.due_date ASC`,
      args: [req.user.email]
    });
    const taskAlerts = taskAlertsRes.rows;

    // "Log My Hours" reminder — fires once Melbourne local time has passed
    // Thursday 8am for the CURRENT week and this user has no timesheet_weeks
    // row for that week beyond 'draft' (i.e. hasn't submitted yet). No
    // scheduler/cron exists in this codebase (checked package.json and every
    // setInterval in server.js), so this is a live pull check on every bell
    // fetch, not a real push notification — same "stays until the real state
    // changes" philosophy as taskAlerts, self-clearing the moment they submit.
    const hoursAlertsRes = await db.execute({
      sql: `WITH mel AS (SELECT now() AT TIME ZONE '${TIMESHEET_TZ}' AS ts),
            bounds AS (SELECT (ts::date - EXTRACT(DOW FROM ts)::int) AS week_start, ts FROM mel)
            SELECT b.week_start::text AS week_start, (b.week_start + 6)::text AS week_end
            FROM bounds b
            WHERE b.ts >= (b.week_start + 4)::timestamp + interval '8 hours'
              AND NOT EXISTS (
                SELECT 1 FROM timesheet_weeks tw
                WHERE LOWER(tw.user_email) = LOWER(?) AND tw.week_start_date = b.week_start AND tw.status != 'draft'
              )`,
      args: [req.user.email]
    });
    const hoursAlerts = hoursAlertsRes.rows;

    // Anyone @mentioned either in a task note OR a task description —
    // informational, dismissible via notification_dismissals same as
    // leave/feedback decisions. Two sources unioned together: a note is an
    // immutable log entry (mentioned_emails frozen at post time), a
    // description is a mutable field (mentioned_emails recomputed on every
    // save — see resolveDescriptionMentions in routes/tasks.js). `kind`
    // tells the frontend which one it's looking at and shapes the
    // dismissal key (`taskmention:note:<id>` vs `taskmention:task:<id>`).
    const taskMentionsRes = await db.execute({
      sql: `SELECT 'note' AS kind, n.id AS mention_id, n.task_id, n.body, n.author_name, n.author_email, n.created_at,
                   t.title AS task_title, (d.user_email IS NOT NULL) AS is_read
            FROM task_notes n
            JOIN tasks t ON t.id = n.task_id
            LEFT JOIN notification_dismissals d ON d.notification_key = 'taskmention:note:' || n.id AND d.user_email = ?
            WHERE n.mentioned_emails @> to_jsonb(LOWER(?)::text)
            UNION ALL
            SELECT 'task' AS kind, t.id AS mention_id, t.id AS task_id, COALESCE(t.description, '') AS body,
                   t.created_by_name AS author_name, t.created_by AS author_email, t.created_at,
                   t.title AS task_title, (d.user_email IS NOT NULL) AS is_read
            FROM tasks t
            LEFT JOIN notification_dismissals d ON d.notification_key = 'taskmention:task:' || t.id AND d.user_email = ?
            WHERE t.mentioned_emails @> to_jsonb(LOWER(?)::text)
            ORDER BY created_at DESC LIMIT 30`,
      args: [req.user.email, req.user.email, req.user.email, req.user.email]
    });
    const taskMentions = taskMentionsRes.rows;

    const unreadCount = receivedGreetings.filter(g => !g.is_read).length
      + upcomingEvents.filter(e => !e.alreadySent).length
      + announcements.filter(a => !a.is_read).length
      + trainingAssignments.length
      + leaveApprovals.length
      + leaveDecisions.filter(l => !l.is_read).length
      + feedbackDecisions.filter(f => !f.is_read).length
      + taskAlerts.length
      + taskMentions.filter(m => !m.is_read).length
      + hoursAlerts.length;
    res.json({ upcomingEvents, receivedGreetings, announcements, trainingAssignments, leaveApprovals, leaveDecisions, feedbackDecisions, taskAlerts, taskMentions, hoursAlerts, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admins schedule (or immediately send, by omitting send_at) a broadcast
// announcement to every signed-in user.
router.post('/announcements', requireAdmin, async (req, res) => {
  const { title, message, send_at } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  try {
    const db = getDb();
    // Guards against a duplicate POST (double-click, a second tab, or a
    // retry firing before the frontend's own disable-while-submitting
    // guard kicks in) creating two identical broadcasts — confirmed to
    // have actually happened once, two rows 0.7s apart that then each got
    // separately shown and acknowledged in the bell.
    const dupe = await db.execute({
      sql: `SELECT id FROM announcements
            WHERE created_by_email = ? AND title = ? AND message = ?
              AND created_at > now() - interval '15 seconds'
            ORDER BY created_at DESC LIMIT 1`,
      args: [req.user.email, title.trim(), message.trim()]
    });
    if (dupe.rows[0]) return res.json({ success: true, id: dupe.rows[0].id });

    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO announcements (id, title, message, send_at, created_by_email, created_by_name)
            VALUES (?, ?, ?, COALESCE(?, now()), ?, ?)`,
      args: [id, title.trim(), message.trim(), send_at || null, req.user.email, req.user.name || req.user.email]
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edits an existing announcement's title/message/send_at in place —
// deliberately does NOT touch announcement_reads or notification_
// dismissals, so a typo fix doesn't reset who's already acknowledged it
// or clear it back into everyone's bell.
router.put('/announcements/:id', requireAdmin, async (req, res) => {
  const { title, message, send_at } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  try {
    const result = await getDb().execute({
      sql: 'UPDATE announcements SET title = ?, message = ?, send_at = COALESCE(?, send_at) WHERE id = ?',
      args: [title.trim(), message.trim(), send_at || null, req.params.id]
    });
    if (!result.rowsAffected) return res.status(404).json({ error: 'Announcement not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletes an announcement and everything hanging off it — attached files
// (DB row + the actual Storage object, same as DELETE /announcements/
// files/:id below), acknowledgments, and bell dismissals — so nothing
// orphaned is left behind referencing an id that no longer exists.
router.delete('/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const filesRes = await db.execute({ sql: 'SELECT storage_path FROM announcement_files WHERE announcement_id = ?', args: [req.params.id] });
    for (const f of filesRes.rows) {
      if (f.storage_path) {
        try { await removeFile(BUCKETS.announcementFiles, f.storage_path); } catch { /* orphaned storage object, non-fatal */ }
      }
    }
    await db.execute({ sql: 'DELETE FROM announcement_files WHERE announcement_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM announcement_reads WHERE announcement_id = ?', args: [req.params.id] });
    await db.execute({ sql: "DELETE FROM notification_dismissals WHERE notification_key = 'announcement:' || ?", args: [req.params.id] });
    const result = await db.execute({ sql: 'DELETE FROM announcements WHERE id = ?', args: [req.params.id] });
    if (!result.rowsAffected) return res.status(404).json({ error: 'Announcement not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full archive — every announcement ever sent, like the article list.
// Admins/super_admins also see not-yet-sent (scheduled) ones; everyone else
// only sees announcements whose send_at has passed.
router.get('/announcements/all', async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const result = await getDb().execute({
      sql: `SELECT a.*, (r.user_email IS NOT NULL) AS is_acked, r.read_at AS acked_at,
                   COALESCE(f.files, '[]'::json) AS files
            FROM announcements a
            LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_email = ?
            LEFT JOIN LATERAL (
              SELECT json_agg(json_build_object(
                'id', af.id, 'filename', af.filename, 'mimetype', af.mimetype,
                'filesize', af.filesize, 'display_mode', af.display_mode
              ) ORDER BY af.created_at ASC) AS files
              FROM announcement_files af WHERE af.announcement_id = a.id
            ) f ON true
            WHERE a.send_at <= now() OR ?
            ORDER BY a.send_at DESC`,
      args: [req.user.email, isAdmin]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Explicit acknowledgment — the tickbox flow. Unlike the old auto-mark-read,
// this is the ONLY way an announcement gets recorded as read; nothing else
// (viewing it, the bulk read-all endpoint) marks it read on the user's behalf.
router.post('/announcements/:id/ack', async (req, res) => {
  try {
    await getDb().execute({
      sql: `INSERT INTO announcement_reads (announcement_id, user_email) VALUES (?, ?)
            ON CONFLICT (announcement_id, user_email) DO NOTHING`,
      args: [req.params.id, req.user.email]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-announcement acknowledgment report — every active user, and whether/
// when they've ticked "I have read and understood this update".
router.get('/announcements/:id/report', requireAdmin, async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT u.email, u.name, (r.user_email IS NOT NULL) AS acked, r.read_at AS acked_at
            FROM users u
            LEFT JOIN announcement_reads r ON r.announcement_id = ? AND r.user_email = u.email
            WHERE u.active = true
            ORDER BY acked ASC, u.name ASC`,
      args: [req.params.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/announcements/:id/files', requireAdmin, announcementFileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { displayMode = 'download' } = req.body;
  try {
    const db = getDb();
    const annRes = await db.execute({ sql: 'SELECT id FROM announcements WHERE id = ?', args: [req.params.id] });
    if (!annRes.rows[0]) return res.status(404).json({ error: 'Announcement not found' });

    const result = await db.execute({
      sql: 'INSERT INTO announcement_files (announcement_id, filename, mimetype, filesize, display_mode) VALUES (?, ?, ?, ?, ?) RETURNING id',
      args: [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, displayMode]
    });
    const fileId = result.rows[0].id;
    const storagePath = `${fileId}.${extForMimetype(req.file.mimetype)}`;
    await ensureBucket(BUCKETS.announcementFiles);
    await uploadBuffer(BUCKETS.announcementFiles, storagePath, req.file.buffer, req.file.mimetype);
    await db.execute({ sql: 'UPDATE announcement_files SET storage_path = ? WHERE id = ?', args: [storagePath, fileId] });

    res.json({ success: true, id: fileId, filename: req.file.originalname, displayMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/announcements/files/:id', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT storage_path FROM announcement_files WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM announcement_files WHERE id = ?', args: [req.params.id] });
    if (existing.rows[0]?.storage_path) {
      try { await removeFile(BUCKETS.announcementFiles, existing.rows[0].storage_path); } catch { /* orphaned storage object, non-fatal */ }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/announcements/file/:fileId', async (req, res) => {
  try {
    const file = (await getDb().execute({ sql: 'SELECT * FROM announcement_files WHERE id = ?', args: [req.params.fileId] })).rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!file.storage_path) return res.status(404).json({ error: 'This attachment has no stored content' });
    const buffer = await downloadAsBuffer(BUCKETS.announcementFiles, file.storage_path);
    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', file.display_mode === 'download'
      ? `attachment; filename="${encodeURIComponent(file.filename)}"`
      : `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generates a message without saving anything — lets the sender see exactly
// what the recipient will see before committing to send it.
router.post('/preview', async (req, res) => {
  const { teamMemberId, type } = req.body;
  if (!teamMemberId || !['birthday', 'anniversary'].includes(type)) {
    return res.status(400).json({ error: 'teamMemberId and a valid type ("birthday" or "anniversary") are required' });
  }
  try {
    const targetRes = await getDb().execute({ sql: 'SELECT id, name FROM team_members WHERE id = ?', args: [teamMemberId] });
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'Team member not found' });
    const message = await generateGreetingMessage(type, target.name);
    res.json({ message, recipientName: target.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/greet', async (req, res) => {
  const { teamMemberId, type, message: previewedMessage } = req.body;
  if (!teamMemberId || !['birthday', 'anniversary'].includes(type)) {
    return res.status(400).json({ error: 'teamMemberId and a valid type ("birthday" or "anniversary") are required' });
  }
  try {
    const db = getDb();
    const targetRes = await db.execute({ sql: 'SELECT id, name FROM team_members WHERE id = ?', args: [teamMemberId] });
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'Team member not found' });

    // No limit on how many greetings someone can send/receive — a fresh
    // AI-written message each time keeps repeats from feeling copy-pasted.
    // If the caller already previewed a message, send exactly that (rather
    // than silently generating a different one at send time).
    const message = previewedMessage?.trim() || await generateGreetingMessage(type, target.name);
    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO team_greetings (id, team_member_id, greeting_type, message, sent_by_email, sent_by_name)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, teamMemberId, type, message, req.user.email, req.user.name || req.user.email]
    });
    res.json({ success: true, id, recipientName: target.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/read', async (req, res) => {
  try {
    await getDb().execute({ sql: 'UPDATE team_greetings SET is_read = true WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The other half of the pair above — lets someone put a greeting back
// into "unread" after clicking it by mistake, or just to come back to it
// later, rather than read state only ever going one direction.
router.post('/:id/unread', async (req, res) => {
  try {
    await getDb().execute({ sql: 'UPDATE team_greetings SET is_read = false WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismisses a single informational bell item the moment the user actually
// opens it, via the same notification_dismissals mechanism 'read-all' uses
// per-category — without this, leave-decision and feedback-decision items
// only ever cleared via "Mark all read", so they kept reappearing as unread
// every time the user reopened the bell after clicking them (reported by
// several people, incl. Sophia). Deliberately excludes 'announcement' — an
// announcement is only ever marked read via the Announcements tab checkbox
// or "Mark all read", never by opening the bell item, per the existing
// compliance-acknowledgment rule (see openAnnouncementRead).
const DISMISSIBLE_KEY_PREFIXES = ['leave', 'feedback', 'taskmention'];
router.post('/dismiss', async (req, res) => {
  const { key } = req.body;
  const prefix = key?.split(':')[0];
  if (!key || !DISMISSIBLE_KEY_PREFIXES.includes(prefix)) return res.status(400).json({ error: 'Invalid notification key' });
  try {
    await getDb().execute({
      sql: `INSERT INTO notification_dismissals (user_email, notification_key) VALUES (?, ?)
            ON CONFLICT (user_email, notification_key) DO NOTHING`,
      args: [req.user.email, key]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Mark Unread" — the other half of /dismiss above. Removing the
// dismissal row is enough on its own: the GET / handler above never
// filters these buckets by is_read/dismissed, it only styles rows
// differently and counts them into unreadCount, so undoing a dismissal
// here is all it takes for the item to look unread again.
router.post('/undismiss', async (req, res) => {
  const { key } = req.body;
  const prefix = key?.split(':')[0];
  if (!key || !DISMISSIBLE_KEY_PREFIXES.includes(prefix)) return res.status(400).json({ error: 'Invalid notification key' });
  try {
    await getDb().execute({
      sql: 'DELETE FROM notification_dismissals WHERE user_email = ? AND notification_key = ?',
      args: [req.user.email, key]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clears the bell badge: marks received greetings read, and dismisses any
// currently-unread announcements from the bell (via notification_dismissals
// — NOT announcement_reads, so this never fakes the "I have read and
// understood this" compliance acknowledgment, which only the tickbox on the
// Announcements tab can set). Deliberately leaves alone anything that
// represents a required action rather than just information — training
// assignments (only clear on actual completion) and birthday/anniversary
// reminders (only clear once that greeting is actually sent).
router.post('/read-all', async (req, res) => {
  try {
    const db = getDb();
    const teamRes = await db.execute('SELECT id, email FROM team_members WHERE email IS NOT NULL');
    const me = teamRes.rows.find(m => m.email && req.user.email && m.email.toLowerCase() === req.user.email.toLowerCase());
    if (me) {
      await db.execute({ sql: 'UPDATE team_greetings SET is_read = true WHERE team_member_id = ?', args: [me.id] });
    }

    const unreadAnn = await db.execute({
      sql: `SELECT a.id FROM announcements a
            LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_email = ?
            LEFT JOIN notification_dismissals d ON d.notification_key = 'announcement:' || a.id AND d.user_email = ?
            WHERE a.send_at <= now() AND r.user_email IS NULL AND d.user_email IS NULL`,
      args: [req.user.email, req.user.email]
    });
    for (const row of unreadAnn.rows) {
      await db.execute({
        sql: `INSERT INTO notification_dismissals (user_email, notification_key) VALUES (?, ?)
              ON CONFLICT (user_email, notification_key) DO NOTHING`,
        args: [req.user.email, `announcement:${row.id}`]
      });
    }

    const unreadLeave = await db.execute({
      sql: `SELECT lr.id FROM leave_requests lr
            LEFT JOIN notification_dismissals d ON d.notification_key = 'leave:' || lr.id AND d.user_email = ?
            WHERE LOWER(lr.user_email) = LOWER(?) AND lr.status IN ('approved', 'rejected') AND d.user_email IS NULL`,
      args: [req.user.email, req.user.email]
    });
    for (const row of unreadLeave.rows) {
      await db.execute({
        sql: `INSERT INTO notification_dismissals (user_email, notification_key) VALUES (?, ?)
              ON CONFLICT (user_email, notification_key) DO NOTHING`,
        args: [req.user.email, `leave:${row.id}`]
      });
    }

    const unreadFeedback = await db.execute({
      sql: `SELECT f.id FROM feedback f
            LEFT JOIN notification_dismissals d ON d.notification_key = 'feedback:' || f.id AND d.user_email = ?
            WHERE LOWER(f.submitted_by) = LOWER(?) AND f.status = 'done' AND d.user_email IS NULL`,
      args: [req.user.email, req.user.email]
    });
    for (const row of unreadFeedback.rows) {
      await db.execute({
        sql: `INSERT INTO notification_dismissals (user_email, notification_key) VALUES (?, ?)
              ON CONFLICT (user_email, notification_key) DO NOTHING`,
        args: [req.user.email, `feedback:${row.id}`]
      });
    }

    const unreadTaskMentions = await db.execute({
      sql: `SELECT 'note' AS kind, n.id AS mention_id FROM task_notes n
            LEFT JOIN notification_dismissals d ON d.notification_key = 'taskmention:note:' || n.id AND d.user_email = ?
            WHERE n.mentioned_emails @> to_jsonb(LOWER(?)::text) AND d.user_email IS NULL
            UNION ALL
            SELECT 'task' AS kind, t.id AS mention_id FROM tasks t
            LEFT JOIN notification_dismissals d ON d.notification_key = 'taskmention:task:' || t.id AND d.user_email = ?
            WHERE t.mentioned_emails @> to_jsonb(LOWER(?)::text) AND d.user_email IS NULL`,
      args: [req.user.email, req.user.email, req.user.email, req.user.email]
    });
    for (const row of unreadTaskMentions.rows) {
      await db.execute({
        sql: `INSERT INTO notification_dismissals (user_email, notification_key) VALUES (?, ?)
              ON CONFLICT (user_email, notification_key) DO NOTHING`,
        args: [req.user.email, `taskmention:${row.kind}:${row.mention_id}`]
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
