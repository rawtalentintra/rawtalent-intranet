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

function buildSystemPrompt(rubric, calibrationNotes = [], oneOffFeedback = null) {
  const categoryList = rubric.categories.map(c => {
    const base = `- **${c.label}** (${c.weight}%)${c.critical ? ' [ZERO-TOLERANCE]' : ''}\n${c.criteria.map(x => `  - ${x}`).join('\n')}`;
    return c.instructions
      ? `${base}\n  Additional grading instructions for this category, from your reviewer: ${c.instructions}`
      : base;
  }).join('\n');

  const calibrationBlock = calibrationNotes.length
    ? `\n\nStanding calibration notes from your reviewer — these refine how strictly/leniently to apply the rubric above, based on real past corrections. Always apply them:\n${calibrationNotes.map(n => `- ${n}`).join('\n')}`
    : '';

  const feedbackBlock = oneOffFeedback
    ? `\n\nYour reviewer has given specific feedback on THIS call that you must incorporate into your re-scoring:\n"${oneOffFeedback}"\nAdjust whichever category score(s) this feedback bears on, and explain in that category's notes how the feedback changed your assessment.`
    : '';

  return `You are a senior Quality Assurance and Operations Manager for RawTalent, an Australian childcare staffing agency, with deep experience coaching consultants and managing compliance risk in a regulated industry. You are grading a real call transcript against a fixed quality rubric; this call is ${rubric.description}

Your notes will be read by both the consultant being coached and their manager. Grade like the expert you are — weigh operational and compliance consequences, not just surface politeness — not like a generic transcript summariser.

Write in formal Australian English throughout, in every note and the summary (e.g. "organise", "recognise", "behaviour", "centre", "colour", "favourite", "realise") — never American spelling.

Your tone is that of a supportive, experienced coach, not a strict examiner: constructive, encouraging, and fair. Maintain high standards, but do not be harsh — assume good intent, and reserve low scores (1-2) for genuine, meaningful gaps, not minor imperfections. A 3 (Adequate) is a fair, respectable outcome, not a failure. When a behaviour was missed or could improve, say so plainly and briefly, then offer one clear, practical tip for next time — matter-of-fact and encouraging, never dramatic, alarmist, or over-the-top.

Score each category from 1 to 5:
1 = Absent, 2 = Weak, 3 = Adequate, 4 = Strong, 5 = Exemplary

Categories (with weight):
${categoryList}

A category marked [ZERO-TOLERANCE] means: if the transcript shows a factual/compliance error (wrong WWCC status, wrong pay, wrong qualification claim, a compliance concern acknowledged but not resolved or escalated, etc.), score that category 1 or 2 regardless of how confidently or smoothly it was delivered — a warm, well-paced call that mishandles compliance is still a failed call. Weigh the real-world consequence: could this expose RawTalent, the centre, or a child to risk if left unaddressed? This is the one place strictness does not soften — compliance risk is compliance risk — but even here, keep the note's tone constructive rather than alarmist.

Base every score strictly on what is actually in the transcript. Do not invent behaviour that isn't there. If the transcript is too short or unclear to judge a category, score it 3 and say so in the notes.

For EVERY category, without exception, write 3-5 sentences of expert, evidence-based reasoning covering all of the following:
1. Quote or paraphrase the exact moment in the call that drove the score.
2. Explain the operational, compliance, or relationship stake this represents — why it matters to the business, not just whether it "sounded good".
3. State precisely why it earned this number rather than one point higher or lower.
4. Give one concrete, practical coaching tip the rep could apply next time — or, for a 4 or 5, name exactly what they did that should be repeated.

Do not write thin or generic notes for any category, including ones that scored well. A 4 or 5 still deserves the same substantive, specific reasoning as a low score — never let a strong category get less explanation than a weak one, and never skip or shortchange any of the ${rubric.categories.length} categories.${calibrationBlock}${feedbackBlock}

Respond with ONLY valid JSON, no other text, in this exact shape:
{"scores": [{"key": "opening", "score": 1-5, "notes": "3-5 sentences in formal Australian English, covering evidence, operational stake, score justification, and a coaching tip, in a constructive coaching tone"}, ...one entry per category key, all ${rubric.categories.length} required...], "summary": "4-5 sentence overall summary in formal Australian English, of how the call went from an operations manager's perspective, referencing specific moments and the overall risk/coaching priority"}`;
}

async function getCalibrationNotes() {
  const db = getDb();
  const result = await db.execute('SELECT note FROM call_grading_calibration ORDER BY created_at ASC');
  return result.rows.map(r => r.note);
}

async function addCalibrationNote(note, createdBy) {
  const db = getDb();
  const id = uuidv4();
  await db.execute({
    sql: 'INSERT INTO call_grading_calibration (id, note, created_by) VALUES (?, ?, ?)',
    args: [id, note, createdBy || null]
  });
  return id;
}

async function listCalibrationNotes() {
  const db = getDb();
  const result = await db.execute('SELECT * FROM call_grading_calibration ORDER BY created_at DESC');
  return result.rows;
}

async function deleteCalibrationNote(id) {
  await getDb().execute({ sql: 'DELETE FROM call_grading_calibration WHERE id = ?', args: [id] });
}

async function getRubricCustomizations(rubricType) {
  const db = getDb();
  const result = await db.execute({ sql: 'SELECT * FROM call_rubric_customizations WHERE rubric_type = ?', args: [rubricType] });
  const map = {};
  for (const row of result.rows) map[row.category_key] = row;
  return map;
}

// Merges the static rubric definition with any admin-authored customizations
// (an AI-maintained description + longer grading instructions) so both the
// AI's grading prompt and the reference UI always reflect the latest
// guidance a reviewer has taught it — not just the built-in defaults.
async function getEffectiveRubric(rubricType) {
  const base = RUBRICS[rubricType];
  if (!base) return null;
  const customizations = await getRubricCustomizations(rubricType);
  return {
    ...base,
    categories: base.categories.map(c => {
      const custom = customizations[c.key];
      let criteria = c.criteria;
      if (custom?.description) {
        try { criteria = JSON.parse(custom.description); } catch { /* fall back to default criteria */ }
      }
      return { ...c, criteria, instructions: custom?.instructions || null };
    })
  };
}

async function getAllEffectiveRubrics() {
  const [educator, centre] = await Promise.all([getEffectiveRubric('educator'), getEffectiveRubric('centre')]);
  return { educator, centre };
}

// Keeps the short reference-table description in sync with whatever
// in-depth grading instructions a reviewer adds, so the summary a reviewer
// sees never drifts from what the AI is actually being told to check for.
async function summarizeCategoryDescription(rubric, category, instructions) {
  const client = getClient();
  if (!client) return category.criteria; // AI not configured — leave the existing bullets as-is

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 600,
    temperature: 0.3,
    system: `You maintain the short reference description shown for one category of a RawTalent call-quality grading rubric. RawTalent is an Australian childcare staffing agency.

Category: "${category.label}" (part of grading ${rubric.description})

Current summary bullets:
${category.criteria.map(x => `- ${x}`).join('\n')}

The reviewer has just added or updated in-depth grading instructions for this category:
"${instructions}"

Rewrite the summary as 3-5 short, concrete bullet points, in formal Australian English, that combine the original intent above with anything new or changed by these instructions. Keep each bullet to one line — this is a quick-reference summary, not the full instructions.

Respond with ONLY valid JSON, no other text: {"bullets": [string, ...]}`,
    messages: [{ role: 'user', content: 'Update the summary.' }]
  });

  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock?.text || '{}';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    return Array.isArray(parsed.bullets) && parsed.bullets.length ? parsed.bullets : category.criteria;
  } catch {
    console.error('Rubric description summarisation parse failure. Raw response (first 500 chars):', raw.slice(0, 500));
    return category.criteria;
  }
}

async function saveRubricInstructions(rubricType, categoryKey, instructions, updatedBy) {
  const rubric = RUBRICS[rubricType];
  if (!rubric) throw new Error(`Unknown rubric type: ${rubricType}`);
  const category = rubric.categories.find(c => c.key === categoryKey);
  if (!category) throw new Error(`Unknown category: ${categoryKey}`);

  const trimmed = instructions?.trim() || '';
  const db = getDb();

  if (!trimmed) {
    // Clearing instructions reverts the description to the built-in default.
    await db.execute({ sql: 'DELETE FROM call_rubric_customizations WHERE rubric_type = ? AND category_key = ?', args: [rubricType, categoryKey] });
    return { description: category.criteria, instructions: null };
  }

  const bullets = await summarizeCategoryDescription(rubric, category, trimmed);
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO call_rubric_customizations (id, rubric_type, category_key, description, instructions, updated_by)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(rubric_type, category_key) DO UPDATE SET description = excluded.description, instructions = excluded.instructions, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    args: [id, rubricType, categoryKey, JSON.stringify(bullets), trimmed, updatedBy || null]
  });
  return { description: bullets, instructions: trimmed };
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

async function gradeCall(transcriptText, rubricType, feedback = null) {
  if (!RUBRICS[rubricType]) throw new Error(`Unknown rubric type: ${rubricType}`);
  // Effective rubric merges in any admin-authored per-category grading
  // instructions, so a reviewer's added guidance is always applied — not
  // just the built-in criteria.
  const rubric = await getEffectiveRubric(rubricType);

  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');

  const calibrationNotes = await getCalibrationNotes();

  // 7 categories x 3-5 sentences of expert, evidence-based notes (evidence +
  // operational stake + justification + coaching action), plus a richer
  // summary, plus any calibration/feedback context, needs real headroom —
  // too little was cutting the JSON off mid-response and failing to parse.
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 6144,
    // Low temperature so the same call graded twice, or two similar calls,
    // land on consistent standards and tone rather than drifting — the
    // rubric, criteria, and calibration notes are already fixed inputs on
    // every call; this keeps the model's judgement equally consistent.
    temperature: 0.3,
    system: buildSystemPrompt(rubric, calibrationNotes, feedback),
    messages: [{ role: 'user', content: transcriptText.slice(0, 12000) }]
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error('The AI response was cut off before it finished (ran out of output length) — please try again.');
  }

  // Sonnet 5 can emit a thinking block before the actual text block, so the
  // final answer isn't reliably content[0] — find the text block explicitly.
  // (Grabbing content[0] blindly silently defaulted every score to 3 with
  // empty notes whenever a thinking block came first.)
  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock?.text || '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  let parsed;
  try { parsed = JSON.parse(match ? match[0] : raw); }
  catch {
    console.error('Call grading JSON parse failure. Raw response (first 1000 chars):', raw.slice(0, 1000));
    throw new Error('Could not parse the AI grading response — please try again.');
  }

  return computeResult(rubric, parsed.scores, parsed.summary);
}

// Human grading via the manual evaluation form — same weighting/zero-tolerance
// logic as the AI path so scores stay comparable in Call Quality Reporting.
function gradeManual(rubricType, rawScores, summary) {
  const rubric = RUBRICS[rubricType];
  if (!rubric) throw new Error(`Unknown rubric type: ${rubricType}`);
  return computeResult(rubric, rawScores, summary);
}

async function saveEvaluation({ recordingId, repName, callType, rubricType, callDate, durationSeconds, result, evaluatedBy, source, reviewerFeedback }) {
  const db = getDb();
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO call_evaluations
          (id, recording_id, rep_name, call_type, rubric_type, call_date, duration_seconds, category_scores, overall_score, outcome, summary, evaluated_by, source, reviewer_feedback)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, recordingId, repName || null, callType || null, rubricType, callDate || null, durationSeconds || null,
      JSON.stringify(result.categoryScores), result.overallScore, result.outcome, result.summary, evaluatedBy || null, source || 'ai', reviewerFeedback || null
    ]
  });
  return id;
}

module.exports = {
  RUBRICS, gradeCall, gradeManual, saveEvaluation,
  addCalibrationNote, listCalibrationNotes, deleteCalibrationNote,
  getAllEffectiveRubrics, saveRubricInstructions
};
