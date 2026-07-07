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
  const isRead = method.startsWith('conversations.list') || method.startsWith('conversations.history') || method.startsWith('conversations.replies');
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
        sql: `INSERT INTO slack_scan_state (channel_id, channel_name, last_ts, updated_at) VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(channel_id) DO UPDATE SET last_ts = excluded.last_ts, channel_name = excluded.channel_name, updated_at = datetime('now')`,
        args: [channel.id, channel.name, newestTs]
      });
    } catch (err) {
      errors.push({ channel: channel.name, reason: err.message });
    }
  }

  await logActivity('faq_scan', 'Slack scan', 'completed', `${channels.length} channels checked, ${candidatesFound} new candidate${candidatesFound !== 1 ? 's' : ''} found${truncated ? ' (truncated — run again to continue)' : ''}`, triggeredBy);
  return { channelsScanned: channels.length, threadsProcessed, candidatesFound, truncated, errors };
}

module.exports = { runSlackScan, isConfigured: () => !!getToken() };
