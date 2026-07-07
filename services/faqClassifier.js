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

module.exports = { classifyConversation };
