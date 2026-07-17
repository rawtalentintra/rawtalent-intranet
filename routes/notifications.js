const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');

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
  return { daysUntil };
}

// Reminders only fire exactly 2 days before the date, and again on the day
// itself — not a rolling window, so admins get a heads-up to plan something
// and then a same-day nudge, without the panel being cluttered all week.
const REMINDER_DAYS_BEFORE = [0, 2];

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

    // "Upcoming" reminders — admin/super_admin only.
    let upcomingEvents = [];
    if (req.user.role === 'admin' || req.user.role === 'super_admin') {
      // A reminder counts as "already handled" (and stops being unread) once
      // *this* admin has personally sent that person a greeting of that type
      // recently — recently, not ever, so it naturally resets for next
      // year's occurrence instead of being permanently silenced.
      const recentRes = await db.execute({
        sql: `SELECT team_member_id, greeting_type FROM team_greetings
              WHERE sent_by_email = ? AND created_at > now() - interval '5 days'`,
        args: [req.user.email]
      });
      const recentlySent = new Set(recentRes.rows.map(r => `${r.team_member_id}:${r.greeting_type}`));

      for (const m of teamRes.rows) {
        const bday = nextOccurrence(m.birthdate);
        if (bday && REMINDER_DAYS_BEFORE.includes(bday.daysUntil)) {
          upcomingEvents.push({
            teamMemberId: m.id, name: m.name, type: 'birthday', daysUntil: bday.daysUntil,
            headline: bday.daysUntil === 0 ? `It's ${m.name}'s Birthday today! 🎂` : `It's almost ${m.name}'s Birthday! 🎂`,
            action: pick(BIRTHDAY_ACTIONS),
            alreadySent: recentlySent.has(`${m.id}:birthday`)
          });
        }
        const anniv = nextOccurrence(m.employment_date);
        if (anniv && REMINDER_DAYS_BEFORE.includes(anniv.daysUntil)) {
          upcomingEvents.push({
            teamMemberId: m.id, name: m.name, type: 'anniversary', daysUntil: anniv.daysUntil,
            headline: anniv.daysUntil === 0 ? `It's ${m.name}'s Employment Date Anniversary today! 🎉` : `It's almost ${m.name}'s Employment Date Anniversary! 🎉`,
            action: pick(ANNIVERSARY_ACTIONS),
            alreadySent: recentlySent.has(`${m.id}:anniversary`)
          });
        }
      }
      upcomingEvents.sort((a, b) => a.daysUntil - b.daysUntil);
    }

    // Announcements — visible to everyone once send_at has passed. A row
    // scheduled for the future simply doesn't show up yet.
    const annRes = await db.execute({
      sql: `SELECT a.*, (r.user_email IS NOT NULL) AS is_read
            FROM announcements a
            LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_email = ?
            WHERE a.send_at <= now()
            ORDER BY a.send_at DESC LIMIT 30`,
      args: [req.user.email]
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

    const unreadCount = receivedGreetings.filter(g => !g.is_read).length
      + upcomingEvents.filter(e => !e.alreadySent).length
      + announcements.filter(a => !a.is_read).length
      + trainingAssignments.length;
    res.json({ upcomingEvents, receivedGreetings, announcements, trainingAssignments, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admins schedule (or immediately send, by omitting send_at) a broadcast
// announcement to every signed-in user.
router.post('/announcements', requireAdmin, async (req, res) => {
  const { message, send_at } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO announcements (id, message, send_at, created_by_email, created_by_name)
            VALUES (?, ?, COALESCE(?, now()), ?, ?)`,
      args: [id, message.trim(), send_at || null, req.user.email, req.user.name || req.user.email]
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/announcements/:id/read', async (req, res) => {
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

router.post('/read-all', async (req, res) => {
  try {
    const db = getDb();
    const teamRes = await db.execute('SELECT id, email FROM team_members WHERE email IS NOT NULL');
    const me = teamRes.rows.find(m => m.email && req.user.email && m.email.toLowerCase() === req.user.email.toLowerCase());
    if (me) {
      await db.execute({ sql: 'UPDATE team_greetings SET is_read = true WHERE team_member_id = ?', args: [me.id] });
    }
    await db.execute({
      sql: `INSERT INTO announcement_reads (announcement_id, user_email)
            SELECT id, ? FROM announcements WHERE send_at <= now()
            ON CONFLICT (announcement_id, user_email) DO NOTHING`,
      args: [req.user.email]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
