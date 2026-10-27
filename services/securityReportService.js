// Weekly security report (Joy promised Liam at the 22 Oct Weekly Growth &
// Product Sync). Every Monday 8am Melbourne: a saved report (Admin → Security
// Report, super_admin only) plus a task for Joy. Covers the previous 7 days.
// Never includes secret values (keys, tokens, passwords, hashes). Not emailed;
// Joy forwards it herself.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const HEARTBEAT_CLASSIFICATION = '16ab121d-9c7f-414b-9bec-5c6dcf4c9ff2';
const melbDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Record a sign-in attempt (called from routes/auth.js). Email + outcome only.
async function logAuthEvent(req, email, outcome, method = 'password') {
  try {
    await getDb().execute({
      sql: 'INSERT INTO auth_events (email, outcome, method, ip, user_agent) VALUES (?,?,?,?,?)',
      args: [email ? String(email).slice(0, 200) : null, outcome, method, (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64) || null, String(req.headers['user-agent'] || '').slice(0, 200) || null]
    });
  } catch { /* never block a login over logging */ }
}

async function buildReport(periodEnd = melbDay()) {
  const db = getDb();
  const start = addDays(periodEnd, -7);
  const q = (sql, args = []) => db.execute({ sql, args }).then(r => r.rows).catch(() => null);
  const [newUsers, userChanges, tokensNew, tokensUsed, tokensStale, oauthClients, failures, impersonation, rotations, mcpUsage] = await Promise.all([
    q(`SELECT email, name, role, created_at FROM users WHERE created_at >= CAST(? AS date) AND created_at < CAST(? AS date) ORDER BY created_at`, [start, periodEnd]),
    q(`SELECT entity_label, action, changes_summary, changed_by, created_at FROM system_logs WHERE entity_type = 'user' AND created_at >= CAST(? AS date) AND created_at < CAST(? AS date) ORDER BY created_at`, [start, periodEnd]),
    q(`SELECT user_email, label, token_prefix, created_at FROM mcp_tokens WHERE created_at >= CAST(? AS date) AND created_at < CAST(? AS date)`, [start, periodEnd]),
    q(`SELECT user_email, label, token_prefix, last_used_at FROM mcp_tokens WHERE revoked_at IS NULL AND last_used_at >= CAST(? AS date) AND last_used_at < CAST(? AS date)`, [start, periodEnd]),
    q(`SELECT user_email, label, token_prefix, created_at, last_used_at FROM mcp_tokens WHERE revoked_at IS NULL AND created_at < CAST(? AS date) - 30 AND (last_used_at IS NULL OR last_used_at < CAST(? AS date) - 30)`, [periodEnd, periodEnd]),
    q(`SELECT client_name, created_at FROM mcp_oauth_clients WHERE created_at >= CAST(? AS date) AND created_at < CAST(? AS date)`, [start, periodEnd]),
    q(`SELECT email, ip, count(*) n, max(created_at) last FROM auth_events WHERE outcome = 'failed' AND created_at >= CAST(? AS date) AND created_at < CAST(? AS date) GROUP BY 1,2 ORDER BY 3 DESC`, [start, periodEnd]),
    q(`SELECT entity_label, action, changed_by, created_at FROM system_logs WHERE entity_type = 'session' AND created_at >= CAST(? AS date) AND created_at < CAST(? AS date) ORDER BY created_at`, [start, periodEnd]),
    q(`SELECT key_name, last_rotated_on, cycle_days, note FROM key_rotation_schedule ORDER BY key_name`),
    q(`SELECT user_email, count(*) n FROM mcp_usage_log WHERE created_at >= CAST(? AS date) AND created_at < CAST(? AS date) GROUP BY 1`, [start, periodEnd])
  ]);
  const today = new Date(`${periodEnd}T00:00:00Z`);
  const keys = (rotations || []).map(r => {
    const last = r.last_rotated_on ? new Date(r.last_rotated_on) : null;
    const due = last ? new Date(last.getTime() + (r.cycle_days || 30) * 864e5) : null;
    return { key: r.key_name, lastRotated: last ? last.toISOString().slice(0, 10) : null, due: due ? due.toISOString().slice(0, 10) : null, daysLeft: due ? Math.round((due - today) / 864e5) : null, note: r.note };
  });
  const failureTotal = (failures || []).reduce((a, r) => a + Number(r.n), 0);
  const flags = [];
  if (failureTotal >= 10) flags.push(`${failureTotal} failed sign-ins this week`);
  (failures || []).filter(r => Number(r.n) >= 5).forEach(r => flags.push(`${r.n} failed sign-ins for ${r.email || 'unknown'} from ${r.ip || 'unknown IP'}`));
  keys.filter(k => k.daysLeft != null && k.daysLeft < 0).forEach(k => flags.push(`${k.key} is OVERDUE for rotation (was due ${k.due})${k.note ? ': ' + k.note : ''}`));
  keys.filter(k => k.daysLeft != null && k.daysLeft >= 0 && k.daysLeft <= 7).forEach(k => flags.push(`${k.key} is due for rotation in ${k.daysLeft} day(s) (${k.due})`));
  const unknown = keys.filter(k => !k.lastRotated);
  if (unknown.length) flags.push(`${unknown.length} secret(s) have no rotation recorded: ${unknown.map(k => k.key).join(', ')}`);
  if ((tokensStale || []).length) flags.push(`${tokensStale.length} connector token(s) unused for 30+ days, so consider revoking`);
  if ((newUsers || []).some(u => u.role === 'super_admin' || u.role === 'admin')) flags.push('A new admin-level account was created this week');

  return {
    periodStart: start, periodEnd, generatedAt: new Date().toISOString(), flags,
    newUsers: newUsers || [], userChanges: userChanges || [], impersonation: impersonation || [],
    mcp: { newTokens: tokensNew || [], usedTokens: tokensUsed || [], staleTokens: tokensStale || [], newOAuthClients: oauthClients || [], usageByUser: mcpUsage || [] },
    signInFailures: { total: failureTotal, byAccount: failures || [], loggingSince: '2026-10-28' },
    keys,
    manualChecks: [
      'Supabase → Logs → API / Postgres / Storage: filter the last 7 days for requests from IPs other than Railway and the office. HeartBeat can\'t read these logs itself without a Supabase management token, which isn\'t set up on purpose.',
      'Supabase → Authentication / Database → Roles: confirm there are no new database users or API keys you didn\'t create.',
      'Railway → Variables: confirm only you changed variables this week. Railway → Deployments: confirm each deploy matches a HeartBeat change.',
      'Google Workspace admin → Security → Alert centre: check for suspicious sign-ins on @rawtalent.com.au accounts.'
    ],
    notTracked: [
      'Bulk exports (CSV/Excel/PDF downloads) aren\'t logged yet. They can be added if you want them in this report.',
      'The Google Calendar connection stores its sign-in token in the database unencrypted (calendar_oauth_connections). Worth encrypting or moving.'
    ]
  };
}

function reportText(r) {
  const lines = [`HeartBeat security report, ${r.periodStart} to ${r.periodEnd} (7 days)`, ''];
  lines.push(r.flags.length ? `⚠️ Needs a look:\n${r.flags.map(f => '• ' + f).join('\n')}` : '✅ Nothing unusual flagged.', '');
  lines.push(`New users: ${r.newUsers.length}${r.newUsers.length ? ' (' + r.newUsers.map(u => `${u.email}, ${u.role}`).join('; ') + ')' : ''}`);
  lines.push(`User changes/removals logged: ${r.userChanges.length}`);
  lines.push(`Impersonation sessions: ${r.impersonation.filter(i => /start/.test(i.action)).length}`);
  lines.push(`Connector (MCP): ${r.mcp.newTokens.length} new token(s), ${r.mcp.usedTokens.length} used, ${r.mcp.staleTokens.length} unused 30+ days, ${r.mcp.newOAuthClients.length} new app(s) connected`);
  lines.push(`Failed sign-ins: ${r.signInFailures.total} (recorded since ${r.signInFailures.loggingSince})`);
  lines.push('', 'Key rotation:', ...r.keys.map(k => `• ${k.key}: ${k.lastRotated ? `last rotated ${k.lastRotated}, due ${k.due} (${k.daysLeft < 0 ? 'OVERDUE' : k.daysLeft + ' days'})` : 'no rotation recorded'}${k.note ? ' (' + k.note + ')' : ''}`));
  lines.push('', 'Check by hand this week:', ...r.manualChecks.map(m => '• ' + m));
  lines.push('', 'Full report: HeartBeat → Admin → Security Report.');
  return lines.join('\n');
}

async function generateAndSave(periodEnd = melbDay(), { createTask = true } = {}) {
  const db = getDb();
  const r = await buildReport(periodEnd);
  let taskId = null;
  if (createTask) {
    taskId = uuidv4();
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'management', ?, ?, ?, 'to_do', ?, ?, NULL, 'system@rawtalent.internal', 'Auto — Security report', '[]', '[]', '[]')`,
      args: [taskId, HEARTBEAT_CLASSIFICATION, `Security report — week to ${r.periodEnd}${r.flags.length ? ` (${r.flags.length} to check)` : ''}`, reportText(r), r.flags.length ? 'high' : 'normal', JSON.stringify(['joy@rawtalent.com.au'])]
    });
  }
  await db.execute({
    sql: `INSERT INTO security_reports (period_start, period_end, data, task_id) VALUES (?,?,?,?)
          ON CONFLICT (period_start) DO UPDATE SET data = excluded.data, period_end = excluded.period_end, generated_at = now(), task_id = COALESCE(excluded.task_id, security_reports.task_id)`,
    args: [r.periodStart, r.periodEnd, JSON.stringify(r), taskId]
  });
  return r;
}

// Scheduler hook: Mondays 8am Melbourne, once.
async function runScheduled(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now).map(x => [x.type, x.value]));
  if (p.weekday !== 'Mon' || Number(p.hour) !== 8) return null;
  const end = melbDay(now), start = addDays(end, -7);
  const done = (await getDb().execute({ sql: 'SELECT 1 FROM security_reports WHERE period_start = ?', args: [start] })).rows.length;
  if (done) return null;
  return generateAndSave(end);
}

module.exports = { logAuthEvent, buildReport, generateAndSave, runScheduled, reportText };
