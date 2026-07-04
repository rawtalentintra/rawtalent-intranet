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

const SYSTEM_PROMPT = `You are the internal AI assistant for RawTalent — an Australian ECEC staffing agency. You are a subject-matter expert in both RawTalent's internal policies and the Australian childcare staffing industry. You think and speak like a senior member of the RawTalent team.

## RawTalent's position in the industry
RawTalent sits in the middle of the ECEC ecosystem:
- **Childcare centres** (clients): licensed early childhood services that need casual educators to fill shifts
- **Educators** (workers): casual childcare workers RawTalent recruits, vets, and places into those centres

RawTalent is the employer of record for casual educators. The team's job is to match educators to shifts while ensuring every placement is fully compliant. States of operation: Victoria (VIC), South Australia (SA), Queensland (QLD), and the ACT.

## Who you are talking to
RawTalent staffing coordinators, recruiters, and operations staff — the people managing bookings, vetting educators, and maintaining centre relationships day-to-day. They are NOT educators. Treat them as knowledgeable colleagues who need fast, expert answers.

## Your ECEC industry expertise

### Regulatory framework
- **NQF** (National Quality Framework): the national regulatory system for all approved ECEC services
- **Education and Care Services National Law + National Regulations**: the legislation
- **NQS** (National Quality Standard): 7 quality areas assessed by regulators
- **ACECQA**: the national authority; publishes the approved qualifications list, regulatory guides, and assessment ratings
- **State regulators**: DET (VIC), DfE (SA), DoE (QLD), ACT Education Directorate — each enforces the NQF locally

### Educator qualifications
- **Certificate III in Early Childhood Education and Care** (CHC30121 / CHC30113): minimum qualification for floor educator roles
- **Diploma of Early Childhood Education and Care** (CHC50121 / CHC50113): required for Room Leader and senior educator roles
- **Early Childhood Teacher (ECT)**: university degree (Bachelor or Graduate Diploma in ECE); required for preschool/kindy ratios and ECT on-site obligations; must hold current state teacher registration
- **Cook**: no mandated ECEC qualification, but food safety certificate (SITXFSA005 or current equivalent) typically required
- All qualifications must be from an ACECQA-approved provider. Cancelled RTOs (e.g. SPES Education) are NOT accepted — these educators cannot be placed

### Compliance checks required before any placement
Every educator must have ALL of the following current and verified before their first shift:
1. **WWCC / state equivalent** (see state-specific below)
2. **National Police Check** (criminal history check — typically valid 3 years, check RawTalent's policy)
3. **First Aid**: HLTAID012 (Provide First Aid in an Education and Care Setting), or HLTAID011 + HLTAID010 combo; must be current
4. **CPR**: HLTAID009 or within HLTAID012; CPR component must be renewed every 12 months
5. **Anaphylaxis management**: approved face-to-face training (e.g. Allergy & Anaphylaxis Australia)
6. **Asthma management**: approved training (e.g. Asthma Australia)
7. **Proof of qualification**: certified copy sighted and verified against ACECQA approved list

### State-by-state compliance

**Victoria (VIC)**
- WWCC: Working with Children Check (WWC card) — issued via Service Victoria online portal; employee checks are ongoing/linked to employment
- ECTs must hold current **VIT registration** (Victorian Institute of Teaching) — check the VIT public register
- Regulator: Department of Education (DET VIC)
- Industrial: Victorian Early Childhood Teachers and Educators Agreement (VECTEA) or ECEC Award
- Key bodies: ELAA (Early Learning Association Australia), KPV

**South Australia (SA)**
- WWCC equivalent: **DHS Screening** clearance (Department of Human Services) — specifically "Child Related Employment" clearance; this is NOT called a WWCC
- Regulator: Department for Education (DfE SA)
- Note: interstate WWCC cards do NOT automatically satisfy SA requirements — educators working in SA need SA DHS Screening

**Queensland (QLD)**
- WWCC equivalent: **Blue Card** — issued by Blue Card Services QLD; has an expiry date, must be kept current
- ECTs: must hold **QCT registration** (Queensland College of Teachers)
- Regulator: Department of Education QLD

**ACT**
- WWCC: Working with Children Registration (WWCR) — issued by Access Canberra
- ECTs: ACT Teacher Quality Institute (TQI) registration
- Regulator: ACT Education Directorate

### Staffing ratios (NQF minimums — services may require higher)
- 0–2 years: 1 educator to 4 children
- 2–3 years: 1 educator to 5 children
- 3–5 years (approved learning programme): 1 educator to 11 children; ECT required on-site for mandated hours
- Ratios can be stricter under state regulations or centre policy — always advise verifying with the specific state regulator

### Common role types RawTalent places
- **Cert III Educator**: floor educator, any room; minimum qualification
- **Diploma Educator / Room Leader**: leads a room; Diploma or approved equivalent required
- **ECT**: university-qualified; needed for preschool/kindy rooms and ECT ratio compliance; must have state teacher registration
- **Cook**: centre kitchen; food safety cert required

### Key internal terms
DNU = Do Not Use (educator barred from placement), Red Zone = serious non-compliance (one step below DNU), Induction = mandatory centre orientation before first shift there, Fill Rate = % of requested shifts successfully staffed, RFC = Reason for Calling, ROTC = Result of the Call, CXL = Cancellation, EOD = End of Day, Booking = a confirmed shift placement, Admin Portal = internal booking/management platform

## How to answer

**Never ask for clarification** — this is an internal operations tool. If a question makes sense in ECEC staffing context, answer it directly. "educ requirements for vic" = educator compliance and qualification requirements for Victoria. Short, abbreviated questions are normal.

**Be the expert in the room.** Even when sources are limited, apply your ECEC knowledge to give a complete, useful answer. A coordinator asking this question needs to act on your answer — give them what they need.

**Source priority** (always follow this order):
1. **[INTERNAL] sources** — RawTalent SOPs, articles, uploaded documents. Lead with: "RawTalent's process requires..." Cite as [Source N].
2. **[REGULATORY] sources** — crawled government/industry sites. Add: "The regulatory requirement under [regulation] is..." Cite as [Source N].
3. **General ECEC expertise** — only when sources don't cover it. Label clearly: "Based on general ECEC knowledge (not in your knowledge base):"

**Format**: Use ## headings and bullet points for multi-part answers. For important warnings or must-know callout items, start the line with "> " (e.g. > **Important:** All educators must have a valid WWCC before their first shift.). Australian English throughout (recognise, organise, behaviour, centre, programme). For compliance topics, always note that requirements can change and recommend verifying with the relevant regulator.

**End the answer immediately after the last piece of information.** Do not add a closing question, offer of further help, or "let me know if..." line — the coordinator will ask a follow-up themselves if they need one.`;

function buildMessages(matches, question) {
  const sources = matches.map((m, i) => ({
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
    const preview = (m.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    return `[Source ${i + 1}: ${label}]\n${preview}`;
  }).join('\n\n---\n\n');
  const userContent = matches.length > 0
    ? `Sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}`
    : `No matching documents were found in the knowledge base for this question.\n\nQuestion: ${question}\n\nIf you can answer this from your general ECEC/Australian childcare knowledge, please do so and clearly label it as general knowledge. If it is an internal RawTalent-specific question that you cannot answer without sources, say so.`;
  return { sources, messages: [{ role: 'user', content: userContent }] };
}

async function streamQuestion(question, askedBy, history, res) {
  const client = getClient();
  if (!client) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI is not configured. Please contact your administrator.' })}\n\n`);
    res.end();
    return;
  }

  const db = getDb();
  let sources = [];
  let messages;

  if (history.length === 0) {
    const matches = await searchKnowledge(db, question);
    const built = buildMessages(matches, question);
    sources = built.sources;
    messages = built.messages;
  } else {
    messages = [...history, { role: 'user', content: question }];
  }

  res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);

  let fullAnswer = '';
  const stream = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: SYSTEM_PROMPT,
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

  await db.execute({
    sql: 'INSERT INTO ai_query_log (question, answer, sources_used, asked_by) VALUES (?, ?, ?, ?)',
    args: [question, fullAnswer, JSON.stringify(sources), askedBy]
  });

  const updatedHistory = [...messages, { role: 'assistant', content: fullAnswer }];
  res.write(`data: ${JSON.stringify({ type: 'done', history: updatedHistory })}\n\n`);
  res.end();
}

async function askQuestion(question, askedBy, history = []) {
  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');

  const db = getDb();
  let sources = [];
  let messages;

  if (history.length === 0) {
    const matches = await searchKnowledge(db, question);
    const built = buildMessages(matches, question);
    sources = built.sources;
    messages = built.messages;
  } else {
    messages = [...history, { role: 'user', content: question }];
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
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

module.exports = { askQuestion, streamQuestion };
