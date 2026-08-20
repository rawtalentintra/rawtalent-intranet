// Best-effort AI read of an attached call/visit transcript, so the Log a
// Call/Visit modal can pre-fill Outcome and a short Notes summary the
// moment a file is attached — same lightweight classification pattern as
// callGradingService.js's detectRubricType (Haiku, a single forced tool
// call, no free-text JSON to parse). Never throws — a failure here should
// never block attaching a file or saving a visit, it just means those two
// fields stay blank for the user to fill in by hand, same as today when
// nothing is attached at all.
const Anthropic = require('@anthropic-ai/sdk');

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const MIN_TEXT_LENGTH = 20;

const TOOL = {
  name: 'summarize_visit',
  description: 'Classify the outcome of this call/visit and write a short summary of what happened.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['positive', 'neutral', 'concern', 'issue_raised'], description: 'positive: went well, centre engaged/happy. neutral: routine, nothing notable either way. concern: something to keep an eye on but not urgent. issue_raised: a real problem the centre raised that needs follow-up.' },
      notesSummary: { type: 'string', description: 'Short, brief, clear summary of what happened on this call/visit — 1 to 3 sentences, plain English.' }
    },
    required: ['outcome', 'notesSummary']
  }
};

async function analyzeVisitFromTranscript(text, centreName) {
  const client = getClient();
  if (!client || !text || text.trim().length < MIN_TEXT_LENGTH) return { outcome: null, notesSummary: null };

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You summarize call/site-visit transcripts for RawTalent, an Australian childcare staffing agency. This is a transcript of a RawTalent Workforce Partner's call or visit with ${centreName || 'a childcare centre'}. Classify the outcome and write a short, brief, clear summary of what actually happened — in formal Australian English. Call summarize_visit exactly once.`,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'summarize_visit' },
      messages: [{ role: 'user', content: text.slice(0, 12000) }]
    });
    const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'summarize_visit');
    if (!toolUse) return { outcome: null, notesSummary: null };
    return { outcome: toolUse.input.outcome || null, notesSummary: toolUse.input.notesSummary || null };
  } catch (err) {
    console.error('Centre visit transcript analysis failed (non-fatal):', err.message);
    return { outcome: null, notesSummary: null };
  }
}

module.exports = { analyzeVisitFromTranscript };
