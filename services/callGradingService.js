const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Same eight categories and weights for both rubrics, so scores stay comparable
// across rep and team once Call Quality Reporting rolls this up — only the
// criteria descriptions differ by who's on the other end of the call.
const RUBRICS = {
  educator: {
    label: 'Educator-Facing',
    description: 'Calls to/from educators — offers, confirmations, cancellations, vetting check-ins.',
    categories: [
      { key: 'opening', label: 'Opening & Rapport', weight: 15, critical: false, criteria: [
        'Greets warmly, states name and purpose within the first 10 seconds',
        'Tone reads as a real person, not a script being read aloud'
      ]},
      { key: 'listening', label: 'Active Listening', weight: 20, critical: false, criteria: [
        "Lets the educator finish before responding; no talking over",
        'Reflects back what was heard before moving on ("so you\'re saying...")',
        "Picks up on hesitation or concern in the educator's voice and addresses it directly"
      ]},
      { key: 'compliance', label: 'Compliance Accuracy', weight: 20, critical: true, criteria: [
        'WWCC / qualification / First Aid status correctly checked before confirming',
        'States pay, shift details, and requirements accurately — nothing promised that isn\'t true'
      ]},
      { key: 'critical_thinking', label: 'Critical Thinking & Proactiveness', weight: 15, critical: false, criteria: [
        'Offers an alternative shift/solution when the first option falls through, unprompted',
        "Anticipates the educator's next question rather than waiting to be asked"
      ]},
      { key: 'cultural_fit', label: 'Australian Cultural Fit', weight: 15, critical: false, criteria: [
        'Natural, local phrasing and pacing — not stiff, over-formal, or script-literal',
        'Comfortable with informal Australian conversational rhythm without losing professionalism'
      ]},
      { key: 'resolution', label: 'Resolution & Ownership', weight: 10, critical: false, criteria: [
        "Educator's reason for calling is fully resolved, not deflected or half-answered",
        "Rep owns the outcome — doesn't pass the problem along without a plan"
      ]},
      { key: 'closing', label: 'Closing', weight: 5, critical: false, criteria: [
        'Confirms next steps and timing clearly before ending the call'
      ]}
    ]
  },
  centre: {
    label: 'Centre-Facing',
    description: 'Calls to/from childcare centres — filling shifts, booking requests, service issues.',
    categories: [
      { key: 'opening', label: 'Opening & Rapport', weight: 15, critical: false, criteria: [
        'Greets warmly, identifies RawTalent and purpose immediately',
        "Matches the centre contact's tone — brisk if they're busy, relaxed if they're not"
      ]},
      { key: 'listening', label: 'Active Listening', weight: 20, critical: false, criteria: [
        'Captures the exact shift need — room, ratio, dates, urgency — without repeat questions',
        'Notices frustration (e.g. repeat unfilled shifts) and acknowledges it before problem-solving'
      ]},
      { key: 'compliance', label: 'Compliance Accuracy', weight: 20, critical: true, criteria: [
        'Only offers educators who are genuinely qualified and cleared for the room/ratio requested',
        "Represents educator experience and availability truthfully — no overselling to win the booking"
      ]},
      { key: 'critical_thinking', label: 'Critical Thinking & Proactiveness', weight: 15, critical: false, criteria: [
        "Proposes a workable option when the ideal match isn't available, rather than reporting a dead end",
        'Flags likely future gaps (e.g. recurring shift) before the centre has to ask'
      ]},
      { key: 'cultural_fit', label: 'Australian Cultural Fit', weight: 15, critical: false, criteria: [
        'Speaks like a colleague the centre already trusts, not a distant call centre voice',
        'Reads as confident and locally fluent under time pressure'
      ]},
      { key: 'resolution', label: 'Resolution & Ownership', weight: 10, critical: false, criteria: [
        'Shift is filled or a firm next step is committed to before the call ends',
        'No "I\'ll get back to you" without a specific time attached'
      ]},
      { key: 'closing', label: 'Closing', weight: 5, critical: false, criteria: [
        "Recaps who's confirmed, for when, before hanging up"
      ]}
    ]
  }
};

function buildSystemPrompt(rubric) {
  const categoryList = rubric.categories.map(c =>
    `- **${c.label}** (${c.weight}%)${c.critical ? ' [ZERO-TOLERANCE]' : ''}\n${c.criteria.map(x => `  - ${x}`).join('\n')}`
  ).join('\n');

  return `You are grading a real RawTalent call transcript against a fixed quality rubric. RawTalent is an Australian childcare staffing agency; this call is ${rubric.description}

Score each category from 1 to 5:
1 = Absent, 2 = Weak, 3 = Adequate, 4 = Strong, 5 = Exemplary

Categories (with weight):
${categoryList}

A category marked [ZERO-TOLERANCE] means: if the transcript shows a factual/compliance error (wrong WWCC status, wrong pay, wrong qualification claim, etc.), score that category 1 or 2 regardless of how confidently or smoothly it was delivered — a warm, well-paced call that gives wrong information is still a failed call.

Base every score strictly on what is actually in the transcript. Do not invent behaviour that isn't there. If the transcript is too short or unclear to judge a category, score it 3 and say so in the notes.

For every category, write 2-4 sentences of specific, evidence-based reasoning: quote or paraphrase the exact moment in the call that drove the score, explain why it earned that number rather than one point higher or lower, and name anything the rep could have done differently. Generic notes like "handled the call well" are not acceptable — reference what was actually said.

Respond with ONLY valid JSON, no other text, in this exact shape:
{"scores": [{"key": "opening", "score": 1-5, "notes": "2-4 sentences of specific reasoning, referencing what was actually said in the call"}, ...one entry per category key...], "summary": "3-4 sentence overall summary of how the call went, referencing specific moments"}`;
}

// Shared by AI grading and manual (human) grading so both produce comparable
// weighted scores/outcomes for the future Call Quality Reporting rollup.
function computeResult(rubric, rawScores, summary) {
  const categoryScores = rubric.categories.map(c => {
    const found = (rawScores || []).find(s => s.key === c.key);
    return {
      category: c.label,
      key: c.key,
      weight: c.weight,
      critical: c.critical,
      score: found?.score ?? 3,
      notes: found?.notes ?? ''
    };
  });

  const weightedScore = categoryScores.reduce((sum, c) => sum + (c.score / 5) * c.weight, 0);
  const criticalFailed = categoryScores.some(c => c.critical && c.score <= 2);
  // A critical/compliance failure caps the score and forces escalation, regardless
  // of how well everything else scored.
  const overallScore = criticalFailed ? Math.min(weightedScore, 65) : weightedScore;

  let outcome;
  if (criticalFailed) outcome = 'escalate';
  else if (overallScore >= 85) outcome = 'pass';
  else if (overallScore >= 70) outcome = 'coaching';
  else outcome = 'escalate';

  return { categoryScores, overallScore: Math.round(overallScore * 10) / 10, outcome, summary: summary || '' };
}

async function gradeCall(transcriptText, rubricType) {
  const rubric = RUBRICS[rubricType];
  if (!rubric) throw new Error(`Unknown rubric type: ${rubricType}`);

  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2500,
    system: buildSystemPrompt(rubric),
    messages: [{ role: 'user', content: transcriptText.slice(0, 12000) }]
  });

  // Sonnet 5 can emit a thinking block before the actual text block, so the
  // final answer isn't reliably content[0] — find the text block explicitly.
  // (Grabbing content[0] blindly silently defaulted every score to 3 with
  // empty notes whenever a thinking block came first.)
  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock?.text || '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  let parsed;
  try { parsed = JSON.parse(match ? match[0] : raw); }
  catch { throw new Error('Could not parse the AI grading response'); }

  return computeResult(rubric, parsed.scores, parsed.summary);
}

// Human grading via the manual evaluation form — same weighting/zero-tolerance
// logic as the AI path so scores stay comparable in Call Quality Reporting.
function gradeManual(rubricType, rawScores, summary) {
  const rubric = RUBRICS[rubricType];
  if (!rubric) throw new Error(`Unknown rubric type: ${rubricType}`);
  return computeResult(rubric, rawScores, summary);
}

async function saveEvaluation({ recordingId, repName, callType, rubricType, callDate, durationSeconds, result, evaluatedBy, source }) {
  const db = getDb();
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO call_evaluations
          (id, recording_id, rep_name, call_type, rubric_type, call_date, duration_seconds, category_scores, overall_score, outcome, summary, evaluated_by, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, recordingId, repName || null, callType || null, rubricType, callDate || null, durationSeconds || null,
      JSON.stringify(result.categoryScores), result.overallScore, result.outcome, result.summary, evaluatedBy || null, source || 'ai'
    ]
  });
  return id;
}

module.exports = { RUBRICS, gradeCall, gradeManual, saveEvaluation };
