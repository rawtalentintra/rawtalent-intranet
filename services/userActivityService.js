// Activity log for tracked (external/temporary) accounts. Joy, 26 Nov 2026.
// Every request by a user with track_activity = true is written to user_activity_log
// (method, path, query, status, and the *names* of fields sent on changes, never values).
// Joy gets a Slack DM each evening summarising what they viewed and changed. Joy only.
const { getDb } = require('../db/database');
const JOY = (process.env.ACTIVITY_REPORT_EMAIL || 'joy@rawtalent.com.au').toLowerCase();

function middleware(req, res, next) {
  const u = req.user;
  if (!u || !u.track_activity) return next();
  if (/\.(js|css|png|jpe?g|svg|ico|woff2?|map|webmanifest)$/i.test(req.path)) return next();
  res.on('finish', () => {
    const q = Object.keys(req.query || {}).length ? JSON.stringify(req.query).slice(0, 500) : null;
    const keys = req.method !== 'GET' && req.body && typeof req.body === 'object' ? Object.keys(req.body).join(',').slice(0, 300) : null;
    getDb().execute({ sql: 'INSERT INTO user_activity_log (user_id, email, method, path, query, status, body_keys) VALUES (?,?,?,?,?,?,?)',
      args: [u.id, u.email, req.method, req.originalUrl.split('?')[0].slice(0, 300), q, res.statusCode, keys] }).catch(e => console.error('[activity]', e.message));
  });
  next();
}

async function dailyReport() {
  const db = getDb();
  const users = (await db.execute(`SELECT DISTINCT email FROM user_activity_log WHERE created_at >= now() - interval '24 hours'`)).rows;
  const slack = require('./slackService');
  if (!slack.isConfigured()) return;
  const tracked = (await db.execute(`SELECT email, name FROM users WHERE track_activity = true`)).rows;
  for (const t of tracked) {
    const rows = (await db.execute({ sql: `SELECT method, path, count(*) n, min(created_at) first_at, max(created_at) last_at FROM user_activity_log
      WHERE email = ? AND created_at >= now() - interval '24 hours' GROUP BY method, path ORDER BY (method <> 'GET') DESC, n DESC LIMIT 40`, args: [t.email] })).rows;
    const fmt = d => new Date(d).toLocaleTimeString('en-AU', { timeZone: 'Australia/Melbourne', hour: 'numeric', minute: '2-digit' });
    let msg;
    if (!rows.length) msg = `🕵️ *HeartBeat activity: ${t.name || t.email}* (last 24h)\nNo activity.`;
    else {
      const first = rows.reduce((a, r) => a < new Date(r.first_at) ? a : new Date(r.first_at), new Date());
      const last = rows.reduce((a, r) => a > new Date(r.last_at) ? a : new Date(r.last_at), new Date(0));
      const changes = rows.filter(r => r.method !== 'GET'), views = rows.filter(r => r.method === 'GET');
      msg = `🕵️ *HeartBeat activity: ${t.name || t.email}* (last 24h, ${fmt(first)}–${fmt(last)})\n` +
        `*Changes (${changes.length}):*\n${changes.map(r => `• ${r.method} ${r.path} ×${r.n}`).join('\n') || '• none'}\n` +
        `*Viewed:*\n${views.slice(0, 25).map(r => `• ${r.path} ×${r.n}`).join('\n') || '• none'}\n` +
        `Full log: ${process.env.APP_URL || 'https://rawtalent-internal.app'}/api/admin/activity-log?email=${encodeURIComponent(t.email)}`;
    }
    await slack.sendDmByEmail(JOY, msg);
  }
  return users.length;
}

module.exports = { middleware, dailyReport };
