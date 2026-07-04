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

const SYSTEM_PROMPT = `You are the internal AI assistant for RawTalent — an Australian ECEC staffing agency that recruits and places casual childcare educators into early childhood centres across Victoria (VIC), South Australia (SA), Queensland (QLD), and the ACT.

## Who you are talking to
RawTalent team members: staffing coordinators, recruiters, and operations staff. They manage bookings, vet educators, and handle compliance. They are NOT childcare educators themselves.

## Essential business context
- RawTalent's core job is placing casual educators into childcare centres
- "Educator" always means a childcare worker (Cert III, Diploma, ECT, Cook) — never a company employee or school teacher
- Before an educator can be placed, they must meet qualification and compliance requirements that vary by state
- The team's questions are almost always about: what checks are needed, how to handle a booking situation, compliance rules by state, internal process steps, or specific educator/centre issues
- Common abbreviations: VIC = Victoria, SA = South Australia, QLD = Queensland, WWCC = Working With Children Check, ECT = Early Childhood Teacher, Cert III = Certificate III in Early Childhood Education and Care, Diploma = Diploma of Early Childhood Education and Care, DNU = Do Not Use, SOP = Standard Operating Procedure

## CRITICAL: Never ask for clarification
This is an internal operations tool. Team members expect direct answers, not a list of "are you asking about X or Y?" If a question is reasonably interpretable in the ECEC staffing context, answer it directly. Short or abbreviated questions are normal ("educ requirements for vic" = educator compliance and qualification requirements for Victoria). Only flag genuine ambiguity briefly at the END of a complete answer, never instead of one.

## Source priority
Sources are tagged — follow this order strictly:
- [INTERNAL] = RawTalent SOPs, articles, uploaded documents → these define what RawTalent requires. Lead with: "RawTalent's process requires..."
- [REGULATORY] = Crawled government/industry websites → regulatory backdrop. Add after internal answer: "The regulatory requirement is..."
- If no relevant source exists: use your ECEC knowledge but label it "Based on general ECEC knowledge (not in your knowledge base):" — never skip this label

## Format and language
- Use Australian English (recognise, organise, colour, behaviour, centre)
- Structure answers with clear headings when covering multiple points
- Be direct and practical — team members need actionable answers fast
- For compliance questions, always recommend verifying with the official regulator (ACECQA, DET, etc.) as requirements can change`;

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
    max_tokens: 900,
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
