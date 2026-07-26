const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { logActivity } = require('./activityLog');
const { classifyConversation } = require('./faqClassifier');

const FATHOM_API = 'https://api.fathom.ai/external/v1';
const MAX_MEETINGS_PER_SCAN = 100;
const DEFAULT_LOOKBACK_DAYS = 30; // for the very first scan

function getToken() {
  return process.env.FATHOM_API_KEY || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fathom's API rate-limits fairly aggressively on the paginated /meetings
// endpoint when include_transcript is set — back off and retry rather than
// failing a whole sync over a transient 429.
async function fathomCall(path, params = {}) {
  const token = getToken();
  if (!token) throw new Error('Fathom is not configured. Set FATHOM_API_KEY.');
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${FATHOM_API}${path}${qs ? `?${qs}` : ''}`, {
      headers: { 'X-Api-Key': token }
    });
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Fathom API error (${path}): ${res.status} ${res.statusText}`);
    return res.json();
  }
  throw new Error(`Fathom API error (${path}): too many rate-limit retries`);
}

async function listMeetingsSince(createdAfter) {
  let items = [];
  let cursor;
  let first = true;
  do {
    const data = await fathomCall('/meetings', {
      include_transcript: 'true',
      created_after: createdAfter,
      ...(cursor ? { cursor } : {})
    });
    items = items.concat(data.items || []);
    cursor = data.next_cursor || null;
    if (!first) await sleep(1200); // pagination also rate-limits back-to-back
    first = false;
  } while (cursor);
  return items;
}

function transcriptToText(transcript) {
  if (!Array.isArray(transcript)) return '';
  return transcript.map(line => line.text).filter(Boolean).join('\n');
}

async function runFathomScan(triggeredBy) {
  if (!getToken()) throw new Error('Fathom is not configured. Set the FATHOM_API_KEY environment variable.');

  const db = getDb();
  const stateRes = await db.execute("SELECT last_synced_at FROM fathom_scan_state WHERE id = 1");
  const createdAfter = stateRes.rows[0]?.last_synced_at || new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const meetings = await listMeetingsSince(createdAfter);
  let meetingsProcessed = 0;
  let candidatesFound = 0;
  let truncated = false;
  const errors = [];
  let newestCreatedAt = createdAfter;

  for (const meeting of meetings) {
    if (meetingsProcessed >= MAX_MEETINGS_PER_SCAN) { truncated = true; break; }
    try {
      if (meeting.created_at && new Date(meeting.created_at) > new Date(newestCreatedAt)) {
        newestCreatedAt = meeting.created_at;
      }

      const sourceRef = String(meeting.url || meeting.share_url || meeting.meeting_url || meeting.created_at);
      const existing = await db.execute({ sql: 'SELECT id FROM faq_candidates WHERE source_ref = ?', args: [sourceRef] });
      if (existing.rows[0]) continue;

      meetingsProcessed++;
      const text = transcriptToText(meeting.transcript);
      if (!text.trim()) continue;

      const classification = await classifyConversation(text);
      const isCandidate = classification.isFaqCandidate && classification.question && classification.answer;
      const meetingTitle = meeting.title || meeting.meeting_title || 'Fathom meeting';
      await db.execute({
        sql: `INSERT INTO faq_candidates
              (id, source, source_channel, source_ref, source_date, raw_excerpt, suggested_question, suggested_answer, classification_reason, status)
              VALUES (?, 'fathom', ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          uuidv4(), meetingTitle, sourceRef, meeting.recording_start_time || meeting.created_at || null, text.slice(0, 4000),
          classification.question || null, classification.answer || null, classification.reason || null,
          isCandidate ? 'pending' : 'auto_rejected'
        ]
      });
      if (isCandidate) candidatesFound++;
    } catch (err) {
      errors.push({ meeting: meeting.title || meeting.meeting_title || meeting.url, reason: err.message });
    }
  }

  await db.execute({
    sql: `INSERT INTO fathom_scan_state (id, last_synced_at, updated_at) VALUES (1, ?, now())
          ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, updated_at = now()`,
    args: [newestCreatedAt]
  });

  await logActivity('faq_scan', 'Fathom scan', 'completed', `${meetings.length} meetings checked, ${candidatesFound} new candidate${candidatesFound !== 1 ? 's' : ''} found${truncated ? ' (truncated — run again to continue)' : ''}`, triggeredBy);
  return { meetingsScanned: meetings.length, meetingsProcessed, candidatesFound, truncated, errors };
}

// Persists FULL transcripts (with per-line speaker attribution) into
// fathom_meetings, so any future analysis (e.g. "what did Liam say about
// project X") can query Postgres instead of re-hitting the Fathom API.
// Separate sync-state row from the FAQ scan above, since the two jobs
// have different lookback needs and shouldn't interfere with each other.
async function syncTranscripts(triggeredBy) {
  if (!getToken()) throw new Error('Fathom is not configured. Set the FATHOM_API_KEY environment variable.');

  const db = getDb();
  const stateRes = await db.execute('SELECT last_synced_at FROM fathom_transcript_sync_state WHERE id = 1');
  const createdAfter = stateRes.rows[0]?.last_synced_at || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const meetings = await listMeetingsSince(createdAfter);
  let newestCreatedAt = createdAfter;
  let stored = 0;
  const errors = [];

  for (const meeting of meetings) {
    try {
      if (meeting.created_at && new Date(meeting.created_at) > new Date(newestCreatedAt)) {
        newestCreatedAt = meeting.created_at;
      }
      if (!meeting.recording_id) continue;

      const speakers = [...new Set((meeting.transcript || []).map(l => l.speaker?.display_name).filter(Boolean))];
      const transcriptText = (meeting.transcript || []).map(l => `${l.speaker?.display_name || '?'}: ${l.text}`).join('\n');
      await db.execute({
        sql: `INSERT INTO fathom_meetings
              (recording_id, title, meeting_url, share_url, fathom_created_at, recording_start_time, recording_end_time,
               transcript, transcript_text, speakers, calendar_invitees, default_summary, action_items, highlights, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
              ON CONFLICT (recording_id) DO UPDATE SET
                title = excluded.title, meeting_url = excluded.meeting_url, share_url = excluded.share_url,
                transcript = excluded.transcript, transcript_text = excluded.transcript_text, speakers = excluded.speakers,
                calendar_invitees = excluded.calendar_invitees, default_summary = excluded.default_summary,
                action_items = excluded.action_items, highlights = excluded.highlights, synced_at = now()`,
        args: [
          meeting.recording_id, meeting.title || meeting.meeting_title || null,
          meeting.meeting_url || null, meeting.share_url || meeting.url || null,
          meeting.created_at || null, meeting.recording_start_time || null, meeting.recording_end_time || null,
          JSON.stringify(meeting.transcript || []), transcriptText, speakers,
          JSON.stringify(meeting.calendar_invitees || []), meeting.default_summary || null,
          JSON.stringify(meeting.action_items || null), JSON.stringify(meeting.highlights || null)
        ]
      });
      stored++;
    } catch (err) {
      errors.push({ meeting: meeting.title || meeting.meeting_title || meeting.url, reason: err.message });
    }
  }

  await db.execute({
    sql: `INSERT INTO fathom_transcript_sync_state (id, last_synced_at, updated_at) VALUES (1, ?, now())
          ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, updated_at = now()`,
    args: [newestCreatedAt]
  });

  await logActivity('fathom_transcript_sync', 'Fathom transcript sync', 'completed', `${meetings.length} meetings checked, ${stored} stored/updated`, triggeredBy);
  return { meetingsScanned: meetings.length, stored, errors };
}

async function getSyncStatus() {
  const db = getDb();
  const [stateRes, countRes] = await Promise.all([
    db.execute('SELECT last_synced_at FROM fathom_transcript_sync_state WHERE id = 1'),
    db.execute('SELECT COUNT(*) AS count FROM fathom_meetings')
  ]);
  return {
    configured: !!getToken(),
    lastSyncedAt: stateRes.rows[0]?.last_synced_at || null,
    meetingCount: Number(countRes.rows[0]?.count || 0)
  };
}

// websearch_to_tsquery (used everywhere else in the app for articles/faqs)
// ANDs every term together, which is too strict for a question like "the
// reference check redesign" — if the actual meeting never says the word
// "redesign", it's excluded entirely even though it's clearly the right
// meeting. This matters more here than for article search because meeting
// transcripts are free-flowing conversation, not curated prose written to
// match likely search terms — and a real acronym mismatch (the project is
// called "OSHC" but the team only ever says "OSH" out loud) means an exact
// AND match can miss the single most relevant meeting entirely.
//
// So the primary lane here ORs the question's significant words together
// (ts_rank still rewards matching more terms and title hits, so meetings
// matching everything still surface first) — recall matters more than
// precision for retrieval, since the answering model is explicitly told to
// only use what a transcript actually says and to admit when nothing
// relevant turned up.
async function searchMeetings(question, limit = 15) {
  const db = getDb();
  const parsed = await db.execute({ sql: "SELECT plainto_tsquery('english', ?)::text AS q", args: [question] });
  const orQuery = (parsed.rows[0]?.q || '').replace(/ & /g, ' | ');
  if (!orQuery) return [];

  try {
    const res = await db.execute({
      sql: `SELECT recording_id, title, share_url, recording_start_time, fathom_created_at, transcript_text
            FROM fathom_meetings
            WHERE search_vector @@ to_tsquery('english', ?)
            ORDER BY ts_rank(search_vector, to_tsquery('english', ?)) DESC
            LIMIT ?`,
      args: [orQuery, orQuery, limit]
    });
    return res.rows;
  } catch {
    return [];
  }
}

const MEETINGS_SYSTEM_PROMPT = `You are an internal meeting-research assistant for RawTalent (an Australian childcare staffing agency), used privately by the Ops Manager to look back through past team meetings.

You will be given full, speaker-attributed transcript excerpts from meetings that matched the user's question via search, each labeled with its title, date, and a link. Answer ONLY from these transcripts — never invent or assume anything that isn't actually said in them.

**Critical requirements:**
1. If the topic came up in multiple meetings, cover ALL of them — don't just pick the most recent or most detailed one. The user explicitly wants to see every relevant discussion so they can judge for themselves which is most current or relevant.
2. Every fact, decision, or quote you state must be attributed to a specific meeting with its date, e.g. "On 1 July 2026 (Edge EL - Booking Approval), Liam said...". Never give an unattributed claim.
3. If different meetings say different or conflicting things about the same topic (e.g. an earlier plan that was later changed), point that out explicitly and note which is more recent, rather than silently picking one.
4. If the provided transcripts don't actually answer the question, say so plainly — do not stretch a tangentially related mention into an answer.
5. Structure longer answers with clear sections per sub-topic or per meeting where that helps; keep it scannable — this is a working tool, not a report.
6. Australian English throughout.

End the answer immediately after the last piece of information — no closing offer of further help.`;

function buildMeetingContext(matches) {
  const MAX_CONTEXT_CHARS = 650000; // ~160K tokens, comfortable under Opus's 1M window with room for output
  const sources = [];
  const blocks = [];
  let used = 0;
  for (const m of matches) {
    const date = m.recording_start_time || m.fathom_created_at;
    const dateStr = date ? new Date(date).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'unknown date';
    const block = `[Meeting: "${m.title || 'Untitled meeting'}" — ${dateStr} — ${m.share_url || 'no link'}]\n${m.transcript_text || ''}`;
    if (used + block.length > MAX_CONTEXT_CHARS && sources.length > 0) break; // always include at least the top match
    blocks.push(block);
    used += block.length;
    sources.push({ title: m.title || 'Untitled meeting', date: date || null, url: m.share_url || null });
  }
  return { sources, context: blocks.join('\n\n---\n\n') };
}

async function streamMeetingsAnswer(question, askedBy, history, res) {
  const Anthropic = require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI is not configured. Please contact your administrator.' })}\n\n`);
    res.end();
    return;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let sources = [];
  let messages;
  if (history.length === 0) {
    const matches = await searchMeetings(question);
    const built = buildMeetingContext(matches);
    sources = built.sources;
    const userContent = matches.length
      ? `Transcripts:\n\n${built.context}\n\n---\n\nQuestion: ${question}`
      : `No meetings matched this question in the transcript archive.\n\nQuestion: ${question}\n\nTell the user plainly that nothing relevant was found — don't guess.`;
    messages = [{ role: 'user', content: userContent }];
  } else {
    messages = [...history, { role: 'user', content: question }];
  }

  res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);

  let fullAnswer = '';
  const stream = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: MEETINGS_SYSTEM_PROMPT,
    messages,
    stream: true
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const chunk = event.delta.text;
      fullAnswer += chunk;
      res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
    }
  }

  const db = getDb();
  await db.execute({
    sql: 'INSERT INTO ai_query_log (question, answer, sources_used, asked_by) VALUES (?, ?, ?, ?)',
    args: [question, fullAnswer, JSON.stringify(sources), askedBy]
  });

  const updatedHistory = [...messages, { role: 'assistant', content: fullAnswer }];
  res.write(`data: ${JSON.stringify({ type: 'done', history: updatedHistory })}\n\n`);
  res.end();
}

module.exports = { runFathomScan, syncTranscripts, getSyncStatus, searchMeetings, streamMeetingsAnswer, isConfigured: () => !!getToken() };
