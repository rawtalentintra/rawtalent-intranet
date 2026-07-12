const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { searchKnowledge } = require('./aiService');
const { classifyOperationalNote } = require('./faqClassifier');

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

function buildSystemPrompt(rubric, repName, knowledgeMatches = [], calibrationNotes = [], oneOffFeedback = null) {
  const categoryList = rubric.categories.map(c => {
    const base = `- **${c.label}** (${c.weight}%)${c.critical ? ' [ZERO-TOLERANCE]' : ''}\n${c.criteria.map(x => `  - ${x}`).join('\n')}`;
    return c.instructions
      ? `${base}\n  Additional grading instructions for this category, from your reviewer: ${c.instructions}`
      : base;
  }).join('\n');

  // Grounds grading in the exact same knowledge base staff get answers from
  // (articles, approved FAQs, documents), so a compliance/process judgement
  // call here matches what the main KB AI would tell someone who asked —
  // the two are never working off different versions of the truth.
  const knowledgeBlock = knowledgeMatches.length
    ? `\n\nRelevant entries from RawTalent's knowledge base (the same source used to answer staff questions) — treat these as the authoritative source of truth whenever this call touches on them, e.g. compliance timeframes, pay rates, or process steps:\n${knowledgeMatches.map(m => `- "${m.title}": ${(m.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`).join('\n')}\nIf you rely on one of these entries to justify a score, name it explicitly in that category's notes (e.g. "per the knowledge base entry '${knowledgeMatches[0]?.title}'...") so the reviewer can verify the claim themselves — never assert something is documented policy without naming the specific entry.`
    : '';

  const calibrationBlock = calibrationNotes.length
    ? `\n\nStanding calibration notes from your reviewer — these refine how strictly/leniently to apply the rubric above, based on real past corrections. Always apply them:\n${calibrationNotes.map(n => `- ${n}`).join('\n')}`
    : '';

  const feedbackBlock = oneOffFeedback
    ? `\n\nYour reviewer has given specific feedback on THIS call that you must incorporate into your re-scoring:\n"${oneOffFeedback}"\nAdjust whichever category score(s) this feedback bears on, and explain in that category's notes how the feedback changed your assessment.`
    : '';

  const repIdentityBlock = repName
    ? `\n\nThe RawTalent consultant on this call is named "${repName}" — this is confirmed from the call record, not something to infer from the transcript. Always refer to the consultant being graded as "${repName}" in your notes and summary. The transcript may mention other people by name (the educator, a centre contact, a colleague) — never confuse one of them with the consultant, and never substitute a different name for the consultant even if the transcript's speaker labels are generic (e.g. "Rep:", "Agent:") or a different name is mentioned elsewhere in the call.`
    : '';

  return `You are a senior Quality Assurance and Operations Manager for RawTalent, an Australian childcare staffing agency, with deep experience coaching consultants and managing compliance risk in a regulated industry. You are grading a real call transcript against a fixed quality rubric; this call is ${rubric.description}${repIdentityBlock}

Your notes will be read by both the consultant being coached and their manager. Grade like the expert you are — weigh operational and compliance consequences, not just surface politeness — not like a generic transcript summariser.

Write in formal Australian English throughout, in every note and the summary (e.g. "organise", "recognise", "behaviour", "centre", "colour", "favourite", "realise") — never American spelling.

Your tone is that of a supportive, experienced coach, not a strict examiner: constructive, encouraging, and fair. Maintain high standards, but do not be harsh — assume good intent, and reserve low scores (1-2) for genuine, meaningful gaps, not minor imperfections. A 3 (Adequate) is a fair, respectable outcome, not a failure. When a behaviour was missed or could improve, say so plainly and briefly, then offer one clear, practical tip for next time — matter-of-fact and encouraging, never dramatic, alarmist, or over-the-top.

Score each category from 1 to 5:
1 = Absent, 2 = Weak, 3 = Adequate, 4 = Strong, 5 = Exemplary

Categories (with weight):
${categoryList}

A category marked [ZERO-TOLERANCE] means: if the transcript shows a factual/compliance error (wrong WWCC status, wrong pay, wrong qualification claim, a compliance concern acknowledged but not resolved or escalated, etc.), score that category 1 or 2 regardless of how confidently or smoothly it was delivered — a warm, well-paced call that mishandles compliance is still a failed call. Weigh the real-world consequence: could this expose RawTalent, the centre, or a child to risk if left unaddressed? This is the one place strictness does not soften — compliance risk is compliance risk — but even here, keep the note's tone constructive rather than alarmist.

Base every score strictly on what is actually in the transcript. Do not invent behaviour that isn't there. If the transcript is too short or unclear to judge a category, score it 3 and say so in the notes.

For EVERY one of these ${rubric.categories.length} categories, without exception — ${rubric.categories.map(c => `"${c.key}"`).join(', ')} — write 3-5 sentences of expert, evidence-based reasoning covering all of the following:
1. Quote or paraphrase the exact moment in the call that drove the score.
2. Explain the operational, compliance, or relationship stake this represents — why it matters to the business, not just whether it "sounded good".
3. State precisely why it earned this number rather than one point higher or lower.
4. Give one concrete, practical coaching tip the rep could apply next time — or, for a 4 or 5, name exactly what they did that should be repeated.

Do not write thin or generic notes for any category, including ones that scored well. A 4 or 5 still deserves the same substantive, specific reasoning as a low score — never let a strong category get less explanation than a weak one, and never leave any category's notes blank or shorter than the others. If a category genuinely cannot be judged from the transcript, still write 3-5 sentences explaining why, rather than leaving it empty.

When quoting the transcript, use plain text only — never HTML tags or markup of any kind, even if the transcript itself contains any (strip it out silently).${knowledgeBlock}${calibrationBlock}${feedbackBlock}

Call the submit_grading tool exactly once, with one scores entry for each of these exact keys: ${rubric.categories.map(c => `"${c.key}"`).join(', ')} — no more, no fewer.`;
}

// Grading is submitted as a tool call rather than free-text JSON — the API
// guarantees the arguments are well-formed, so a long note with a stray
// quote, apostrophe, or line break can no longer produce unparseable output
// (previously the single biggest cause of "Could not parse the AI grading
// response", since the model had to hand-escape its own JSON string values).
function buildGradingTool(rubric) {
  const keys = rubric.categories.map(c => c.key);
  return {
    name: 'submit_grading',
    description: 'Submit the completed call quality grading — one score and note per category, plus an overall summary.',
    input_schema: {
      type: 'object',
      properties: {
        scores: {
          type: 'array',
          minItems: keys.length,
          maxItems: keys.length,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: keys },
              score: { type: 'integer', minimum: 1, maximum: 5 },
              notes: { type: 'string', description: '3-5 sentences in formal Australian English, covering evidence, operational stake, score justification, and a coaching tip, in a constructive coaching tone.' }
            },
            required: ['key', 'score', 'notes']
          }
        },
        summary: { type: 'string', description: '4-5 sentence overall summary in formal Australian English, of how the call went from an operations manager\'s perspective, referencing specific moments and the overall risk/coaching priority.' }
      },
      required: ['scores', 'summary']
    }
  };
}

async function getCalibrationNotes() {
  const db = getDb();
  const result = await db.execute('SELECT note FROM call_grading_calibration ORDER BY created_at ASC');
  return result.rows.map(r => r.note);
}

// If a correction taught to the call grader is actually general company
// knowledge (not just a grading preference), surface it as a pending FAQ
// candidate for human review — the same gate Slack/Fathom/document
// candidates go through. Once approved, it's searchable by both this
// grader (via searchKnowledge above) and the main KB AI, closing the loop.
async function maybeCreateFaqCandidateFromNote(noteText, sourceRef) {
  try {
    const classification = await classifyOperationalNote(noteText);
    if (!classification.isFaqCandidate || !classification.question || !classification.answer) return;
    const db = getDb();
    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO faq_candidates (id, source, source_ref, raw_excerpt, suggested_question, suggested_answer, classification_reason)
            VALUES (?, 'call-evaluator', ?, ?, ?, ?, ?)`,
      args: [id, sourceRef, noteText.slice(0, 500), classification.question, classification.answer, classification.reason || 'Learned from call grading feedback']
    });
  } catch (err) {
    console.error('Failed to create FAQ candidate from grading note (non-fatal):', err.message);
  }
}

async function addCalibrationNote(note, createdBy) {
  const db = getDb();
  const id = uuidv4();
  await db.execute({
    sql: 'INSERT INTO call_grading_calibration (id, note, created_by) VALUES (?, ?, ?)',
    args: [id, note, createdBy || null]
  });
  await maybeCreateFaqCandidateFromNote(note, 'Call grading calibration note');
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
        criteria = custom.description;
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
          ON CONFLICT(rubric_type, category_key) DO UPDATE SET description = excluded.description, instructions = excluded.instructions, updated_by = excluded.updated_by, updated_at = now()`,
    args: [id, rubricType, categoryKey, JSON.stringify(bullets), trimmed, updatedBy || null]
  });
  await maybeCreateFaqCandidateFromNote(trimmed, `Rubric instructions — ${category.label} (${rubric.label})`);
  return { description: bullets, instructions: trimmed };
}

// Direct, non-AI edit of the reference description — for a super_admin who
// wants to fix the wording themselves rather than re-summarising via AI.
// Any existing in-depth instructions for this category are left untouched.
async function saveRubricDescription(rubricType, categoryKey, bullets, updatedBy) {
  const rubric = RUBRICS[rubricType];
  if (!rubric) throw new Error(`Unknown rubric type: ${rubricType}`);
  const category = rubric.categories.find(c => c.key === categoryKey);
  if (!category) throw new Error(`Unknown category: ${categoryKey}`);

  const db = getDb();
  const existing = await db.execute({
    sql: 'SELECT instructions FROM call_rubric_customizations WHERE rubric_type = ? AND category_key = ?',
    args: [rubricType, categoryKey]
  });
  const instructions = existing.rows[0]?.instructions ?? null;
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO call_rubric_customizations (id, rubric_type, category_key, description, instructions, updated_by)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(rubric_type, category_key) DO UPDATE SET description = excluded.description, updated_by = excluded.updated_by, updated_at = now()`,
    args: [id, rubricType, categoryKey, JSON.stringify(bullets), instructions, updatedBy || null]
  });
  return { description: bullets, instructions };
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

// Notes/summaries are meant to be plain text — strips any stray markup
// regardless of where it came from (source transcript, model quirk), as a
// safety net on top of sanitizing the transcript itself before grading.
function stripMarkup(text) {
  return (text || '').replace(/<\/?[a-z][^>]*>/gi, '').trim();
}

async function gradeCall(transcriptText, rubricType, repName = null, feedback = null) {
  if (!RUBRICS[rubricType]) throw new Error(`Unknown rubric type: ${rubricType}`);
  // Effective rubric merges in any admin-authored per-category grading
  // instructions, so a reviewer's added guidance is always applied — not
  // just the built-in criteria.
  const rubric = await getEffectiveRubric(rubricType);

  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');

  // Defends against markup already baked into a stored transcript (e.g. from
  // before the Dubber sync stripped it at the source) leaking into the
  // model's quoted excerpts and corrupting the JSON it has to produce.
  const cleanTranscript = stripMarkup(transcriptText);

  const calibrationNotes = await getCalibrationNotes();

  // Grounds this evaluation in the same knowledge base the main KB AI
  // answers staff questions from, so the two are never out of sync on
  // policy/compliance facts — a failure here is non-fatal to grading.
  let knowledgeMatches = [];
  try {
    knowledgeMatches = await searchKnowledge(getDb(), cleanTranscript.slice(0, 800), 5);
  } catch (err) {
    console.error('Knowledge base lookup failed during call grading (continuing without it):', err.message);
  }

  const system = buildSystemPrompt(rubric, repName, knowledgeMatches, calibrationNotes, feedback);
  const tool = buildGradingTool(rubric);

  async function runOnce() {
    // 7 categories x 3-5 sentences of expert, evidence-based notes (evidence +
    // operational stake + justification + coaching action), plus a richer
    // summary, plus any calibration/feedback context, needs real headroom —
    // too little was cutting the response off mid-way.
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 6144,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'submit_grading' },
      messages: [{ role: 'user', content: cleanTranscript.slice(0, 12000) }]
    });

    if (response.stop_reason === 'max_tokens') {
      throw new Error('The AI response was cut off before it finished (ran out of output length) — please try again.');
    }

    // Tool-call input arrives pre-parsed by the API — no hand-rolled JSON
    // extraction/parsing needed, and no risk of a note containing a stray
    // quote or line break breaking the response (the old free-text-JSON
    // approach's main failure mode).
    const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_grading');
    if (!toolUse) {
      console.error('Call grading response had no submit_grading tool call. stop_reason:', response.stop_reason, 'content types:', response.content.map(b => b.type));
      throw new Error('The AI did not submit a grading — please try again.');
    }
    const parsed = toolUse.input || {};

    // Sanitize whatever the model returned regardless of cause, then check
    // every category actually got a substantive note — an empty one with a
    // score attached means something went wrong generating that entry.
    const scores = (parsed.scores || []).map(s => ({ ...s, notes: stripMarkup(s.notes) }));
    const summary = stripMarkup(parsed.summary);
    const missing = rubric.categories.filter(c => !scores.find(s => s.key === c.key && s.notes && s.notes.length > 20));
    return { scores, summary, missing };
  }

  let result = await runOnce();
  if (result.missing.length) {
    console.error(`Call grading returned incomplete notes for: ${result.missing.map(c => c.key).join(', ')} — retrying once.`);
    result = await runOnce();
    if (result.missing.length) {
      throw new Error(`The AI didn't provide grading notes for: ${result.missing.map(c => c.label).join(', ')} — please try again.`);
    }
  }

  return computeResult(rubric, result.scores, result.summary);
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
  getAllEffectiveRubrics, saveRubricInstructions, saveRubricDescription
};
