const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { logActivity } = require('./activityLog');
const { classifyConversation } = require('./faqClassifier');

const SLACK_API = 'https://slack.com/api';
const MAX_THREADS_PER_SCAN = 150;
const DEFAULT_LOOKBACK_SECONDS = 30 * 24 * 60 * 60; // 30 days, for a channel's first-ever scan

function getToken() {
  return process.env.SLACK_BOT_TOKEN || null;
}

function slackTsToIso(ts) {
  if (!ts) return null;
  return new Date(parseFloat(ts) * 1000).toISOString();
}

async function slackCall(method, params = {}) {
  const token = getToken();
  if (!token) throw new Error('Slack is not configured. Set SLACK_BOT_TOKEN.');
  const isRead = method.startsWith('conversations.list') || method.startsWith('conversations.history') || method.startsWith('conversations.replies') || method === 'users.lookupByEmail' || method === 'users.info';
  let url = `${SLACK_API}/${method}`;
  let opts = { headers: { 'Authorization': `Bearer ${token}` } };
  if (isRead) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(params);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (${method}): ${data.error}`);
  return data;
}

async function listPublicChannels() {
  let channels = [];
  let cursor;
  do {
    const data = await slackCall('conversations.list', {
      types: 'public_channel',
      exclude_archived: 'true',
      limit: '200',
      ...(cursor ? { cursor } : {})
    });
    channels = channels.concat(data.channels);
    cursor = data.response_metadata?.next_cursor || null;
  } while (cursor);
  return channels;
}

async function fetchHistory(channelId, oldest) {
  let messages = [];
  let cursor;
  do {
    const data = await slackCall('conversations.history', {
      channel: channelId,
      limit: '200',
      oldest,
      ...(cursor ? { cursor } : {})
    });
    messages = messages.concat(data.messages);
    cursor = data.has_more ? data.response_metadata?.next_cursor : null;
  } while (cursor);
  return messages;
}

async function fetchThreadReplies(channelId, threadTs) {
  const data = await slackCall('conversations.replies', { channel: channelId, ts: threadTs, limit: '200' });
  return data.messages;
}

async function runSlackScan(triggeredBy) {
  if (!getToken()) throw new Error('Slack is not configured. Set the SLACK_BOT_TOKEN environment variable.');

  const db = getDb();
  const channels = await listPublicChannels();
  let threadsProcessed = 0;
  let candidatesFound = 0;
  let truncated = false;
  const errors = [];

  for (const channel of channels) {
    if (threadsProcessed >= MAX_THREADS_PER_SCAN) { truncated = true; break; }
    try {
      // No auto-join: the bot only reads channels it can already access (e.g. those
      // it was manually invited to), so scanning never triggers a "bot joined" event
      // that would surprise anyone in a channel.
      const stateRes = await db.execute({ sql: 'SELECT last_ts FROM slack_scan_state WHERE channel_id = ?', args: [channel.id] });
      const oldest = stateRes.rows[0]?.last_ts || String(Date.now() / 1000 - DEFAULT_LOOKBACK_SECONDS);

      const messages = await fetchHistory(channel.id, oldest);
      if (!messages.length) continue;

      let newestTs = oldest;
      for (const msg of messages) {
        if (parseFloat(msg.ts) > parseFloat(newestTs)) newestTs = msg.ts;
      }

      const threadParents = messages.filter(m => m.reply_count > 0);

      for (const parent of threadParents) {
        if (threadsProcessed >= MAX_THREADS_PER_SCAN) { truncated = true; break; }
        threadsProcessed++;

        const sourceRef = `${channel.id}:${parent.ts}`;
        const existing = await db.execute({ sql: 'SELECT id FROM faq_candidates WHERE source_ref = ?', args: [sourceRef] });
        if (existing.rows[0]) continue;

        const replies = await fetchThreadReplies(channel.id, parent.ts);
        const text = replies.map(m => m.text).filter(Boolean).join('\n');
        if (!text.trim()) continue;

        const classification = await classifyConversation(text);
        const isCandidate = classification.isFaqCandidate && classification.question && classification.answer;
        await db.execute({
          sql: `INSERT INTO faq_candidates
                (id, source, source_channel, source_ref, source_date, raw_excerpt, suggested_question, suggested_answer, classification_reason, status)
                VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            uuidv4(), channel.name, sourceRef, slackTsToIso(parent.ts), text.slice(0, 4000),
            classification.question || null, classification.answer || null, classification.reason || null,
            isCandidate ? 'pending' : 'auto_rejected'
          ]
        });
        if (isCandidate) candidatesFound++;
      }

      await db.execute({
        sql: `INSERT INTO slack_scan_state (channel_id, channel_name, last_ts, updated_at) VALUES (?, ?, ?, now())
              ON CONFLICT(channel_id) DO UPDATE SET last_ts = excluded.last_ts, channel_name = excluded.channel_name, updated_at = now()`,
        args: [channel.id, channel.name, newestTs]
      });
    } catch (err) {
      errors.push({ channel: channel.name, reason: err.message });
    }
  }

  await logActivity('faq_scan', 'Slack scan', 'completed', `${channels.length} channels checked, ${candidatesFound} new candidate${candidatesFound !== 1 ? 's' : ''} found${truncated ? ' (truncated — run again to continue)' : ''}`, triggeredBy);
  return { channelsScanned: channels.length, threadsProcessed, candidatesFound, truncated, errors };
}

// Direct message to a HeartBeat user by their work email (needs the bot's
// chat:write + users:read.email scopes). Never throws: a Slack hiccup must
// not break whatever triggered it.
async function sendDmByEmail(email, text, blocks) {
  try {
    if (!getToken()) return false;
    const u = await slackCall('users.lookupByEmail', { email });
    await slackCall('chat.postMessage', { channel: u.user.id, text, ...(blocks ? { blocks } : {}), unfurl_links: false });
    return true;
  } catch (err) { console.error('Slack DM failed:', email, err.message); return false; }
}

// Sophia, 9 Nov 2026: a Slack DM whenever ANY task is marked Done.
const TASK_DONE_RECIPIENTS = ['sophia@rawtalent.com.au'];
async function notifyTaskDone(taskId, doneBy) {
  try {
    const t = (await getDb().execute({ sql: `SELECT t.title, t.assigned_to_emails, d.name AS dept, d.icon
      FROM tasks t LEFT JOIN task_departments d ON d.id = t.department_id WHERE t.id = ?`, args: [taskId] })).rows[0];
    if (!t) return;
    const names = async emails => {
      if (!emails.length) return 'Unassigned';
      const r = await getDb().execute({ sql: `SELECT email, name FROM users WHERE lower(email) = ANY(?)`, args: [emails.map(e => String(e).toLowerCase())] });
      const m = new Map(r.rows.map(x => [String(x.email).toLowerCase(), x.name]));
      return emails.map(e => m.get(String(e).toLowerCase()) || e).join(', ');
    };
    const assignees = await names(Array.isArray(t.assigned_to_emails) ? t.assigned_to_emails : []);
    const url = `https://rawtalent-internal.app/?tab=tasks&task=${taskId}`;
    const esc = x => String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = `✅ Task done: ${t.title}`;
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `✅ *Task done:* <${url}|${esc(t.title)}>` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc((t.icon ? t.icon + ' ' : '') + (t.dept || 'No department'))} · Marked done by ${esc(doneBy)} · Assigned to ${esc(assignees)}` }] }
    ];
    await Promise.all(TASK_DONE_RECIPIENTS.map(e => sendDmByEmail(e, text, blocks)));
  } catch (err) { console.error('Task-done Slack notify failed:', err.message); }
}

// Joy, 9 Nov 2026: the task's creator gets a Slack DM whenever someone else
// updates their task (edits or a new note). `changes` = short readable lines.
async function notifyTaskCreator(taskId, creatorEmail, updatedBy, changes) {
  try {
    if (!creatorEmail || !changes || !changes.length) return;
    const t = (await getDb().execute({ sql: 'SELECT title FROM tasks WHERE id = ?', args: [taskId] })).rows[0];
    if (!t) return;
    const esc = x => String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const url = `https://rawtalent-internal.app/?tab=tasks&task=${taskId}`;
    await sendDmByEmail(creatorEmail, `Update on your HeartBeat Task: ${t.title}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `🔔 *Update on your HeartBeat Task:* <${url}|${esc(t.title)}>` } },
      { type: 'section', text: { type: 'mrkdwn', text: changes.map(c => '• ' + esc(c)).join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Updated by ${esc(updatedBy)}` }] }
    ]);
  } catch (err) { console.error('Task-creator Slack notify failed:', err.message); }
}

// Joy, 9 Nov 2026: anyone @tagged on a task gets a shout-out in #daily-check-in.
const TAG_CHANNEL_NAME = 'daily-check-in';
let tagChannelId = null;
async function tagChannel() {
  if (tagChannelId) return tagChannelId;
  const ch = (await listPublicChannels()).find(c => c.name === TAG_CHANNEL_NAME);
  if (!ch) throw new Error('#' + TAG_CHANNEL_NAME + ' not found');
  if (!ch.is_member) await slackCall('conversations.join', { channel: ch.id });
  return (tagChannelId = ch.id);
}
async function notifyTaskTagged(taskId, emails, verb = 'tagged on') {
  try {
    const list = [...new Set((emails || []).map(e => String(e).toLowerCase()))];
    if (!list.length || !getToken()) return;
    const who = [];
    for (const email of list) {
      try { who.push(`<@${(await slackCall('users.lookupByEmail', { email })).user.id}>`); }
      catch (err) {
        const r = await getDb().execute({ sql: 'SELECT name FROM users WHERE lower(email) = ?', args: [email] });
        who.push(r.rows[0] && r.rows[0].name || email);
      }
    }
    const url = `https://rawtalent-internal.app/?tab=tasks&task=${taskId}`;
    const names = who.length > 1 ? who.slice(0, -1).join(', ') + ' and ' + who[who.length - 1] : who[0];
    await slackCall('chat.postMessage', { channel: await tagChannel(), unfurl_links: false,
      text: `:label: Hi ${names}, you were ${verb} a <${url}|HeartBeat Task>. Please check :writing_hand:` });
  } catch (err) { console.error('Task-tag Slack notify failed:', err.message); }
}

module.exports = { notifyTaskCreator, notifyTaskTagged, runSlackScan, isConfigured: () => !!getToken(), sendDmByEmail, notifyTaskDone, TASK_DONE_RECIPIENTS };
