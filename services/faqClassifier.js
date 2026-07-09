const Anthropic = require('@anthropic-ai/sdk');

function getClassifierClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const CLASSIFY_PROMPT = `You review internal conversations (Slack threads or meeting transcripts) for RawTalent, an Australian childcare staffing agency, to find genuinely reusable FAQ material.

Most conversations are NOT suitable — reject anything containing:
- Names of specific staff, educators, centres, or families
- Wages, pay rates, disciplinary matters, performance issues, complaints
- Anything personal, sensitive, or identifying
- One-off situational chat that wouldn't help someone else later

ONLY accept a conversation if it represents a genuine, reusable, general question with a clear answer that would help OTHER staff facing the same question later — e.g. how to handle a category of situation, a process or policy clarification, a general industry/compliance question.

If accepted, rewrite the question and answer in a fully generalised, anonymised form — remove ALL names, dates, and identifying specifics. The question and answer must stand alone with no context from the original conversation.

Respond with ONLY valid JSON, no other text:
{"isFaqCandidate": boolean, "question": string or null, "answer": string or null, "reason": string}`;

async function classifyConversation(text) {
  const client = getClassifierClient();
  if (!client) return { isFaqCandidate: false, reason: 'AI is not configured' };
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: CLASSIFY_PROMPT,
    messages: [{ role: 'user', content: text.slice(0, 6000) }]
  });
  const raw = response.content[0]?.text || '{}';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : raw);
  } catch {
    return { isFaqCandidate: false, reason: 'Could not parse classification response' };
  }
}

// Documents (policy docs, guides) tend to hold several distinct reusable
// Q&As rather than the single conversation classifyConversation() handles,
// so this extracts as many as it can find in one pass instead of one verdict.
async function extractFaqsFromDocument(text, docTitle) {
  const client = getClassifierClient();
  if (!client) return { candidates: [] };

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: `You are reading an internal RawTalent document titled "${docTitle}" to extract genuinely reusable FAQ material for a staff knowledge base. RawTalent is an Australian childcare staffing agency.

Read the whole document and extract every distinct, general, reusable question-and-answer pair you can find or reasonably construct from its content — e.g. policy points, process steps, compliance requirements, common scenarios and how to resolve them. Skip narrative or boilerplate text with no answerable question behind it.

Do not include anything containing:
- Names of specific staff, educators, centres, or families
- Anything personal, sensitive, or identifying

Each answer must be self-contained and clear without needing the rest of the document for context.

Respond with ONLY valid JSON, no other text:
{"candidates": [{"question": string, "answer": string}, ...]}
If there is truly nothing extractable, return {"candidates": []}.`,
    messages: [{ role: 'user', content: text.slice(0, 15000) }]
  });

  // Find the actual text block rather than assuming content[0] — some models
  // can emit a thinking block first, which would otherwise silently parse as "{}".
  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock?.text || '{}';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    return { candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [] };
  } catch {
    console.error('Document FAQ extraction JSON parse failure. Raw response (first 1000 chars):', raw.slice(0, 1000));
    return { candidates: [] };
  }
}

module.exports = { classifyConversation, extractFaqsFromDocument };
