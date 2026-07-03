const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function buildFtsTerm(text) {
  return text
    .replace(/[^\w\s\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .map(t => `"${t}"*`)
    .join(' OR ');
}

async function searchKnowledge(db, question, limit = 6) {
  const term = buildFtsTerm(question);

  async function query(sql, args) {
    try { return (await db.execute({ sql, args })).rows; } catch { return []; }
  }

  // Three independent search lanes — internal sources always get their own slots
  // and can never be displaced by external websites
  const [artRows, docRows, webRows] = await Promise.all([
    // Lane 1 — Internal: published KB articles / SOPs
    query(
      `SELECT a.id, a.title, a.content, a.category, 'article' as source_type, NULL as origin
       FROM articles a JOIN articles_fts fts ON a.id = fts.id
       WHERE articles_fts MATCH ? AND a.published = 1 ORDER BY rank LIMIT 2`,
      [term]
    ),
    // Lane 2 — Internal: uploaded documents (PDF, DOCX, TXT)
    query(
      `SELECT s.id, s.title, s.content, NULL as category, s.type as source_type, s.origin
       FROM knowledge_sources s JOIN knowledge_sources_fts fts ON s.id = fts.id
       WHERE knowledge_sources_fts MATCH ? AND s.type = 'document' ORDER BY rank LIMIT 2`,
      [term]
    ),
    // Lane 3 — External: crawled websites (regulatory / industry)
    query(
      `SELECT s.id, s.title, s.content, NULL as category, s.type as source_type, s.origin
       FROM knowledge_sources s JOIN knowledge_sources_fts fts ON s.id = fts.id
       WHERE knowledge_sources_fts MATCH ? AND s.type = 'website' ORDER BY rank LIMIT 2`,
      [term]
    )
  ]);

  // Internal first (articles → docs → websites), so Claude sees internal context first
  let results = [...artRows, ...docRows, ...webRows];

  // Fallback: if fewer than 3 total results, broaden to individual keywords
  if (results.length < 3) {
    const seen = new Set(results.map(r => r.id));
    const words = question.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
    for (const word of words.slice(0, 4)) {
      if (results.length >= limit) break;
      const wt = `"${word}"*`;
      const [wa, wd, ww] = await Promise.all([
        query(
          `SELECT a.id, a.title, a.content, a.category, 'article' as source_type, NULL as origin
           FROM articles a JOIN articles_fts fts ON a.id = fts.id
           WHERE articles_fts MATCH ? AND a.published = 1 ORDER BY rank LIMIT 1`,
          [wt]
        ),
        query(
          `SELECT s.id, s.title, s.content, NULL as category, s.type as source_type, s.origin
           FROM knowledge_sources s JOIN knowledge_sources_fts fts ON s.id = fts.id
           WHERE knowledge_sources_fts MATCH ? AND s.type = 'document' ORDER BY rank LIMIT 1`,
          [wt]
        ),
        query(
          `SELECT s.id, s.title, s.content, NULL as category, s.type as source_type, s.origin
           FROM knowledge_sources s JOIN knowledge_sources_fts fts ON s.id = fts.id
           WHERE knowledge_sources_fts MATCH ? AND s.type = 'website' ORDER BY rank LIMIT 1`,
          [wt]
        )
      ]);
      for (const r of [...wa, ...wd, ...ww]) {
        if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
      }
    }
  }

  return results.slice(0, limit);
}

const SYSTEM_PROMPT = `You are an internal AI assistant for RawTalent, an Australian ECEC (early childhood education and care) staffing agency. Your job is to answer team members' questions accurately and concisely.

Sources are tagged so you know what to prioritise:
- [INTERNAL] = RawTalent's own SOPs, articles, or uploaded documents. These define what RawTalent requires and how the team operates.
- [REGULATORY] = External government or industry websites. These provide the legal/compliance backdrop.

Answer in this priority order:
1. **RawTalent's internal process first**: If any [INTERNAL] source covers the question, lead with that. Frame it as "RawTalent requires..." or "Our process is...". Cite inline as [Source N].
2. **Regulatory context second**: If [REGULATORY] sources add relevant legal or compliance detail, add them after the internal answer. Frame as "The regulatory requirement is..." or "Under [regulation]...". Cite inline as [Source N].
3. **General ECEC knowledge as a last resort**: If neither source type covers it, you may use your knowledge of Australian ECEC, NQF, ACECQA, and state regulations — but label it "Based on general ECEC knowledge (not in your knowledge base):" so the team member knows to verify it.

Other rules:
- **Typos**: Correct obvious typos or misspellings (e.g. "ACEQA" → ACECQA) and briefly note the correction.
- **Unknown internal processes**: If the question is about a RawTalent-specific process and no [INTERNAL] source covers it, say so — don't guess.
- Be practical and direct. Team members need actionable answers fast.
- For regulatory questions, always recommend verifying with the official source (ACECQA, state regulator, etc.) as requirements change.
- Use Australian English spelling throughout (e.g. recognise, organise, colour, behaviour, centre, programme).`;

async function askQuestion(question, askedBy, history = []) {
  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');

  const db = getDb();
  let sources = [];
  let messages;

  if (history.length === 0) {
    // First turn: search knowledge base and build source context
    const matches = await searchKnowledge(db, question);
    sources = matches.map((m, i) => ({
      index: i + 1,
      title: m.title,
      type: m.source_type,
      id: m.id,
      origin: m.origin || null
    }));
    const contextBlocks = matches.map((m, i) => {
      let label;
      if (m.source_type === 'article') {
        label = `[INTERNAL] RawTalent SOP/Article: ${m.title}${m.category ? ` (${m.category})` : ''}`;
      } else if (m.source_type === 'document') {
        label = `[INTERNAL] Uploaded Document: ${m.title}`;
      } else {
        label = `[REGULATORY] External Website: ${m.title}${m.origin ? ` — ${m.origin}` : ''}`;
      }
      const preview = (m.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
      return `[Source ${i + 1}: ${label}]\n${preview}`;
    }).join('\n\n---\n\n');
    const userContent = matches.length > 0
      ? `Sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}`
      : `No matching documents were found in the knowledge base for this question.\n\nQuestion: ${question}\n\nIf you can answer this from your general ECEC/Australian childcare knowledge, please do so and clearly label it as general knowledge. If it is an internal RawTalent-specific question that you cannot answer without sources, say so.`;
    messages = [{ role: 'user', content: userContent }];
  } else {
    // Follow-up turn: sources already in history context, just append the new question
    messages = [...history, { role: 'user', content: question }];
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages
  });

  const answer = response.content[0]?.text || '';
  const updatedHistory = [...messages, { role: 'assistant', content: answer }];

  await db.execute({
    sql: 'INSERT INTO ai_query_log (question, answer, sources_used, asked_by) VALUES (?, ?, ?, ?)',
    args: [question, answer, JSON.stringify(sources), askedBy]
  });

  return { answer, sources, history: updatedHistory };
}

module.exports = { askQuestion };
