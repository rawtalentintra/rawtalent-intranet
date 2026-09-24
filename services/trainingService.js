const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { searchKnowledge, getGlossaryBlock } = require('./aiService');
const { listCalibrationNotes } = require('./callGradingService');

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Pulls in everything else RawTalent already knows that's topically related
// to this course — articles, AI sources, FAQs, glossary terms, and real
// coaching takeaways from call evaluations/calibration notes — so the
// generated course reflects the same institutional knowledge as the rest of
// the app, not just whatever was pasted/uploaded in isolation. This is
// supplementary grounding for the model, not primary content: the uploaded
// material stays the spine of the course.
async function gatherCourseContext(db, title, description) {
  const query = [title, description].filter(Boolean).join(' ');
  const parts = [];

  try {
    const glossaryBlock = await getGlossaryBlock(db);
    if (glossaryBlock) parts.push(glossaryBlock);
  } catch (err) {
    console.error('Training context: glossary lookup failed (continuing without it):', err.message);
  }

  try {
    const knowledgeResults = await searchKnowledge(db, query, 12);
    if (knowledgeResults.length) {
      const blocks = knowledgeResults.map(r =>
        `### [${r.source_type}] ${r.title}\n${(r.content || '').slice(0, 1500)}`
      ).join('\n\n');
      parts.push(`\n\n## Related Internal Articles, AI Sources & FAQs\n${blocks}`);
    }
  } catch (err) {
    console.error('Training context: knowledge search failed (continuing without it):', err.message);
  }

  try {
    const words = query.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
    if (words.length) {
      const conditions = words.slice(0, 5).map(() => 'summary ILIKE ?').join(' OR ');
      const args = words.slice(0, 5).map(w => `%${w}%`);
      const evalRes = await db.execute({
        sql: `SELECT summary, rubric_type FROM call_evaluations WHERE (${conditions}) AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 5`,
        args
      });
      if (evalRes.rows.length) {
        // Deliberately excludes rep names — this is background context on
        // real call patterns for the model to draw on, not material to
        // quote verbatim into learner-facing content.
        const blocks = evalRes.rows.map(r => `- (${r.rubric_type}) ${r.summary}`).join('\n');
        parts.push(`\n\n## Real Call Evaluation Themes (anonymised — use to identify common real-world mistakes worth addressing, do not quote verbatim)\n${blocks}`);
      }
    }
  } catch (err) {
    console.error('Training context: evaluation search failed (continuing without it):', err.message);
  }

  try {
    const notes = await listCalibrationNotes();
    if (notes.length) {
      const blocks = notes.slice(0, 15).map(n => `- ${n.note}`).join('\n');
      parts.push(`\n\n## Standing Call-Grading Calibration Notes (human-reviewed corrections — treat as authoritative)\n${blocks}`);
    }
  } catch (err) {
    console.error('Training context: calibration notes lookup failed (continuing without it):', err.message);
  }

  return parts.join('');
}

// ── AI generation ────────────────────────────────────────────────
// Breaks source material into logical study modules, each with a short
// comprehension check, plus a final graded assessment drawing across all of
// them — submitted as a single tool call so the whole structure comes back
// well-formed in one shot rather than free-text JSON that can fail to parse.
function buildGenerationTool({ questionsPerModule = { min: 1, max: 3 }, finalAssessmentMin = 5 } = {}) {
  const question = {
    type: 'object',
    properties: {
      questionType: {
        type: 'string',
        enum: ['multiple_choice', 'free_text'],
        description: 'multiple_choice: a question with 3-5 plausible options and one exactly-correct answer, auto-graded. free_text: the learner types their own answer (a one-word answer, a short phrase, or a brief explanation) — a human reviews it afterwards, so use this whenever real understanding is better checked by an explanation than by picking an option.'
      },
      questionText: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5, description: 'Required for multiple_choice. Omit entirely for free_text.' },
      correctAnswer: {
        type: 'string',
        description: 'For multiple_choice: must exactly match one of the strings in options. For free_text: a reference/model answer describing what a correct response should contain — this is shown only to the human reviewer scoring the answer afterwards, never to the learner.'
      }
    },
    required: ['questionType', 'questionText', 'correctAnswer']
  };
  return {
    name: 'submit_course',
    description: 'Submit the structured training course generated from the source material.',
    input_schema: {
      type: 'object',
      properties: {
        modules: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              content: { type: 'string', description: 'Clean HTML (headings, paragraphs, lists, bold) covering this module\'s slice of the material — study content a learner reads, not a summary.' },
              questions: { type: 'array', minItems: questionsPerModule.min, maxItems: questionsPerModule.max, items: question, description: 'Comprehension check questions asked right after this module — mix multiple_choice and free_text rather than defaulting to all multiple_choice.' }
            },
            required: ['title', 'content', 'questions']
          }
        },
        finalAssessment: {
          type: 'array',
          minItems: finalAssessmentMin,
          items: question,
          description: 'Graded assessment questions drawn across all modules, testing retention of the material as a whole — mix multiple_choice and free_text rather than defaulting to all multiple_choice.'
        }
      },
      required: ['modules', 'finalAssessment']
    }
  };
}

// instructions is optional extra per-generation guidance (e.g. "cover every
// state thoroughly, one question per key step") folded into the user
// message rather than the system prompt, since it's specific to this one
// course, not a standing rule for every future course generated.
// questionsPerModule/finalAssessmentMin let a single generation ask for more
// than the everyday default (e.g. a long, comprehensive reference document)
// without changing what a normal course generation produces.
async function generateCourseFromMaterial({ title, description, material, createdBy, instructions, questionsPerModule, finalAssessmentMin }) {
  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');
  if (!material?.trim()) throw new Error('Source material is required to generate a course.');

  const db = getDb();
  const contextBlock = await gatherCourseContext(db, title, description);

  const tool = buildGenerationTool({ questionsPerModule, finalAssessmentMin });
  const system = `You are building internal staff training for RawTalent, an Australian childcare staffing agency. Given raw source material (a process doc, SOP, or reference sheet) plus supplementary context pulled from RawTalent's own knowledge base (internal articles, AI sources, FAQs, glossary, and real call-evaluation/calibration data), break the material into a logical sequence of study modules a new consultant can work through — each module should cover one coherent chunk of the material (e.g. one process, one concept area), not an arbitrary page split.

The uploaded/pasted source material is the SPINE of the course — build modules from it directly. Use the supplementary context to enrich and correct that content: apply glossary terms precisely wherever they're relevant, fold in directly relevant detail from related articles/FAQs/AI sources where it fills a gap the source material leaves open, and — where the call-evaluation themes or calibration notes surface a common real mistake related to this topic — make sure a module or question addresses it. Don't force in unrelated context just because it was provided; only use what's actually relevant to this course's material.

After each module, write comprehension questions that check whether the learner actually understood THAT module's content, using a genuine MIX of both question types available: multiple_choice (plausible wrong answers, not trick questions) and free_text (a one-word answer, a short phrase, or a brief explanation typed by the learner). Reach for free_text whenever real understanding is better shown by explaining something in the learner's own words, or naming a specific fact, than by picking from a list — don't default everything to multiple_choice. Then write a final assessment drawing across the whole course, testing real retention, with the same genuine mix of both types. Write everything in clear, formal Australian English. Call submit_course exactly once.`;

  // Streamed (not a plain create()) because a multi-module course with rich
  // per-module HTML, comprehension questions, and a final assessment can
  // legitimately need tens of thousands of output tokens — well past the
  // point where a non-streaming request risks an SDK HTTP timeout.
  const stream = client.messages.stream({
    model: 'claude-sonnet-5',
    max_tokens: 64000,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'submit_course' },
    messages: [{ role: 'user', content: `Course title: ${title}\n${description ? `Course description: ${description}\n` : ''}${instructions ? `\n${instructions}\n` : ''}\nSource material:\n${material.slice(0, 30000)}${contextBlock ? `\n\n---\n# Supplementary RawTalent Knowledge Base Context\n${contextBlock.slice(0, 15000)}` : ''}` }]
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === 'max_tokens') {
    throw new Error('The AI response was cut off before it finished — try shortening the source material or splitting it into a smaller course.');
  }
  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_course');
  if (!toolUse) throw new Error('Could not generate a course from this material — please try again.');

  return saveCourse({ title, description, material, generated: toolUse.input, createdBy });
}

async function saveCourse({ title, description, material, generated, createdBy }) {
  const db = getDb();
  const courseId = uuidv4();
  await db.execute({
    sql: `INSERT INTO training_courses (id, title, description, status, source_material, created_by)
          VALUES (?, ?, ?, 'draft', ?, ?)`,
    args: [courseId, title, description || '', material || '', createdBy || null]
  });

  for (let mi = 0; mi < generated.modules.length; mi++) {
    const m = generated.modules[mi];
    const moduleId = uuidv4();
    await db.execute({
      sql: `INSERT INTO training_modules (id, course_id, title, content, order_index) VALUES (?, ?, ?, ?, ?)`,
      args: [moduleId, courseId, m.title, m.content, mi]
    });
    for (let qi = 0; qi < (m.questions || []).length; qi++) {
      const q = m.questions[qi];
      const questionType = q.questionType === 'free_text' ? 'free_text' : 'multiple_choice';
      await db.execute({
        sql: `INSERT INTO training_questions (id, course_id, module_id, question_type, question_text, options, correct_answer, order_index)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [uuidv4(), courseId, moduleId, questionType, q.questionText, questionType === 'free_text' ? null : JSON.stringify(q.options), q.correctAnswer, qi]
      });
    }
  }

  for (let qi = 0; qi < generated.finalAssessment.length; qi++) {
    const q = generated.finalAssessment[qi];
    const questionType = q.questionType === 'free_text' ? 'free_text' : 'multiple_choice';
    await db.execute({
      sql: `INSERT INTO training_questions (id, course_id, module_id, question_type, question_text, options, correct_answer, order_index)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
      args: [uuidv4(), courseId, questionType, q.questionText, questionType === 'free_text' ? null : JSON.stringify(q.options), q.correctAnswer, qi]
    });
  }

  return getCourseDetail(courseId);
}

// ── CRUD ────────────────────────────────────────────────────────
// forUserEmail is optional — when given, each course also carries that
// person's own assignment (if any) and their latest attempt, so a plain
// learner's dashboard can show "assigned to you, due X" and their own
// progress without a second round of requests.
async function listCourses(forUserEmail) {
  const db = getDb();
  const coursesRes = await db.execute('SELECT * FROM training_courses ORDER BY created_at DESC');
  const attemptsRes = await db.execute(`
    SELECT course_id, COUNT(*) AS attempts, COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE final_passed = true) AS passed
    FROM training_attempts GROUP BY course_id`);
  const modulesRes = await db.execute('SELECT course_id, COUNT(*) AS module_count FROM training_modules GROUP BY course_id');
  const statsByCourseId = new Map(attemptsRes.rows.map(r => [r.course_id, r]));
  const moduleCountByCourseId = new Map(modulesRes.rows.map(r => [r.course_id, Number(r.module_count)]));

  let myAssignmentByCourseId = new Map();
  let myAttemptByCourseId = new Map();
  if (forUserEmail) {
    const assignRes = await db.execute({ sql: 'SELECT * FROM training_assignments WHERE user_email = ?', args: [forUserEmail] });
    myAssignmentByCourseId = new Map(assignRes.rows.map(r => [r.course_id, r]));
    const myAttemptsRes = await db.execute({
      sql: 'SELECT * FROM training_attempts WHERE user_email = ? ORDER BY started_at DESC',
      args: [forUserEmail]
    });
    for (const a of myAttemptsRes.rows) {
      if (!myAttemptByCourseId.has(a.course_id)) myAttemptByCourseId.set(a.course_id, a);
    }
  }

  return coursesRes.rows.map(c => ({
    ...c,
    module_count: moduleCountByCourseId.get(c.id) || 0,
    stats: statsByCourseId.get(c.id) || { attempts: 0, completed: 0, passed: 0 },
    my_assignment: myAssignmentByCourseId.get(c.id) || null,
    my_attempt: myAttemptByCourseId.get(c.id) || null
  }));
}

// forUserEmail is optional — when given, the result carries that person's
// own assignment (if any), mirroring listCourses, so routes can tell a
// draft course that's been assigned to this specific person (visible on
// their dashboard via listCourses) apart from a draft nobody can see yet.
async function getCourseDetail(courseId, forUserEmail = null) {
  const db = getDb();
  const courseRes = await db.execute({ sql: 'SELECT * FROM training_courses WHERE id = ?', args: [courseId] });
  const course = courseRes.rows[0];
  if (!course) return null;
  const modulesRes = await db.execute({ sql: 'SELECT * FROM training_modules WHERE course_id = ? ORDER BY order_index ASC', args: [courseId] });
  const questionsRes = await db.execute({ sql: 'SELECT * FROM training_questions WHERE course_id = ? ORDER BY order_index ASC', args: [courseId] });
  const modules = modulesRes.rows.map(m => ({
    ...m,
    questions: questionsRes.rows.filter(q => q.module_id === m.id)
  }));
  const finalAssessment = questionsRes.rows.filter(q => !q.module_id);
  let my_assignment = null;
  if (forUserEmail) {
    const assignRes = await db.execute({
      sql: 'SELECT * FROM training_assignments WHERE course_id = ? AND user_email = ?',
      args: [courseId, forUserEmail]
    });
    my_assignment = assignRes.rows[0] || null;
  }
  return { ...course, modules, finalAssessment, my_assignment };
}

async function updateCourse(courseId, { title, description, status, passThreshold }) {
  const db = getDb();
  const fields = [];
  const args = [];
  if (title !== undefined) { fields.push('title = ?'); args.push(title); }
  if (description !== undefined) { fields.push('description = ?'); args.push(description); }
  if (status !== undefined) { fields.push('status = ?'); args.push(status); }
  if (passThreshold !== undefined) { fields.push('pass_threshold = ?'); args.push(passThreshold); }
  if (!fields.length) return;
  fields.push('updated_at = now()');
  args.push(courseId);
  await db.execute({ sql: `UPDATE training_courses SET ${fields.join(', ')} WHERE id = ?`, args });
}

async function deleteCourse(courseId) {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM training_answers WHERE attempt_id IN (SELECT id FROM training_attempts WHERE course_id = ?)', args: [courseId] });
  await db.execute({ sql: 'DELETE FROM training_attempts WHERE course_id = ?', args: [courseId] });
  await db.execute({ sql: 'DELETE FROM training_questions WHERE course_id = ?', args: [courseId] });
  await db.execute({ sql: 'DELETE FROM training_modules WHERE course_id = ?', args: [courseId] });
  await db.execute({ sql: 'DELETE FROM training_courses WHERE id = ?', args: [courseId] });
}

async function updateModule(moduleId, { title, content }) {
  const db = getDb();
  const fields = [];
  const args = [];
  if (title !== undefined) { fields.push('title = ?'); args.push(title); }
  if (content !== undefined) { fields.push('content = ?'); args.push(content); }
  if (!fields.length) return;
  fields.push('updated_at = now()');
  args.push(moduleId);
  await db.execute({ sql: `UPDATE training_modules SET ${fields.join(', ')} WHERE id = ?`, args });
}

async function updateQuestion(questionId, { questionText, options, correctAnswer, questionType }) {
  const db = getDb();
  const fields = [];
  const args = [];
  if (questionText !== undefined) { fields.push('question_text = ?'); args.push(questionText); }
  if (options !== undefined) { fields.push('options = ?'); args.push(JSON.stringify(options)); }
  if (correctAnswer !== undefined) { fields.push('correct_answer = ?'); args.push(correctAnswer); }
  if (questionType !== undefined) { fields.push('question_type = ?'); args.push(questionType); }
  if (!fields.length) return;
  fields.push('updated_at = now()');
  args.push(questionId);
  await db.execute({ sql: `UPDATE training_questions SET ${fields.join(', ')} WHERE id = ?`, args });
}

async function deleteQuestion(questionId) {
  await getDb().execute({ sql: 'DELETE FROM training_questions WHERE id = ?', args: [questionId] });
}

async function deleteModule(moduleId) {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM training_questions WHERE module_id = ?', args: [moduleId] });
  await db.execute({ sql: 'DELETE FROM training_modules WHERE id = ?', args: [moduleId] });
}

// ── Taking a course ──────────────────────────────────────────────
async function startAttempt(courseId, userEmail) {
  const db = getDb();
  // One in-progress attempt per person per course — resume rather than
  // stack up duplicates if they navigate away and come back.
  const existing = await db.execute({
    sql: `SELECT * FROM training_attempts WHERE course_id = ? AND user_email = ? AND status = 'in_progress'`,
    args: [courseId, userEmail]
  });
  if (existing.rows[0]) return existing.rows[0];

  // A passed course reopened is a review, not a retake — "Review (Passed)"
  // in the UI should show the real result, not silently spawn a fresh,
  // empty attempt that shadows the completed one (this was masking real
  // completions in the notification bell, and meant "Review" actually made
  // someone redo the whole course from module 1 instead of showing what
  // they already got). Only a FAILED completed attempt should start fresh
  // — that's a genuine retake.
  const mostRecent = await db.execute({
    sql: `SELECT * FROM training_attempts WHERE course_id = ? AND user_email = ? ORDER BY started_at DESC LIMIT 1`,
    args: [courseId, userEmail]
  });
  if (mostRecent.rows[0]?.status === 'completed' && mostRecent.rows[0]?.final_passed) {
    return mostRecent.rows[0];
  }

  // Same reasoning as the just-passed check above, one status earlier: a
  // pending_review attempt is "done" from the learner's side (they can't
  // add or change anything until it's reviewed) — resuming it should show
  // where it's at, not silently spawn a second attempt that shadows it.
  if (mostRecent.rows[0]?.status === 'pending_review') {
    return mostRecent.rows[0];
  }

  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO training_attempts (id, course_id, user_email) VALUES (?, ?, ?)`,
    args: [id, courseId, userEmail]
  });
  const res = await db.execute({ sql: 'SELECT * FROM training_attempts WHERE id = ?', args: [id] });
  return res.rows[0];
}

async function getAttempt(attemptId) {
  const res = await getDb().execute({ sql: 'SELECT * FROM training_attempts WHERE id = ?', args: [attemptId] });
  return res.rows[0] || null;
}

// multiple_choice grades immediately (exact match). free_text is never
// auto-graded — correct stays null ("pending") until a human reviewer ticks
// it via reviewAnswer(). correct/total below only ever count multiple_choice
// questions, so a course's "you got X of Y correct" line never silently
// counts an unreviewed free_text answer as wrong.
function gradeAnswers(questions, submittedAnswers) {
  let correct = 0;
  let total = 0;
  let pendingReview = 0;
  const results = questions.map(q => {
    const given = submittedAnswers[q.id];
    if (q.question_type === 'free_text') {
      pendingReview++;
      return { questionId: q.id, given, correct: null, questionType: 'free_text' };
    }
    total++;
    const isCorrect = given === q.correct_answer;
    if (isCorrect) correct++;
    return { questionId: q.id, given, correct: isCorrect, questionType: 'multiple_choice' };
  });
  return { correct, total, pendingReview, results };
}

async function submitModuleAnswers(attemptId, moduleId, answers) {
  const db = getDb();
  const attempt = await getAttempt(attemptId);
  if (!attempt) throw new Error('Attempt not found');

  const questionsRes = await db.execute({ sql: 'SELECT * FROM training_questions WHERE module_id = ? ORDER BY order_index ASC', args: [moduleId] });
  const { correct, total, pendingReview, results } = gradeAnswers(questionsRes.rows, answers);

  for (const r of results) {
    await db.execute({
      sql: `INSERT INTO training_answers (id, attempt_id, question_id, selected_answer, is_correct) VALUES (?, ?, ?, ?, ?)`,
      args: [uuidv4(), attemptId, r.questionId, r.given ?? null, r.correct]
    });
  }

  const moduleResults = Array.isArray(attempt.module_results) ? attempt.module_results : [];
  moduleResults.push({ moduleId, correct, total, pendingReview });
  await db.execute({
    sql: `UPDATE training_attempts SET module_results = ?, current_module_index = current_module_index + 1 WHERE id = ?`,
    args: [JSON.stringify(moduleResults), attemptId]
  });

  return { correct, total, pendingReview, results };
}

// If the final assessment has any free_text questions, the real
// final_score/final_passed can't be known yet — the attempt goes to
// 'pending_review' with those fields left null, and only gets finalized once
// every free_text answer on it has been reviewed (see maybeFinalizeAttempt,
// called from reviewAnswer). correct/total here are multiple_choice-only, so
// the learner's immediate feedback never implies a free_text answer was
// marked right or wrong before a human actually looked at it.
async function submitFinalAssessment(attemptId, answers) {
  const db = getDb();
  const attempt = await getAttempt(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  const courseRes = await db.execute({ sql: 'SELECT * FROM training_courses WHERE id = ?', args: [attempt.course_id] });
  const course = courseRes.rows[0];

  const questionsRes = await db.execute({ sql: 'SELECT * FROM training_questions WHERE course_id = ? AND module_id IS NULL ORDER BY order_index ASC', args: [attempt.course_id] });
  const { correct, total, pendingReview, results } = gradeAnswers(questionsRes.rows, answers);

  for (const r of results) {
    await db.execute({
      sql: `INSERT INTO training_answers (id, attempt_id, question_id, selected_answer, is_correct) VALUES (?, ?, ?, ?, ?)`,
      args: [uuidv4(), attemptId, r.questionId, r.given ?? null, r.correct]
    });
  }

  if (pendingReview > 0) {
    await db.execute({ sql: `UPDATE training_attempts SET status = 'pending_review' WHERE id = ?`, args: [attemptId] });
    return { correct, total, pendingReview, status: 'pending_review', score: null, passed: null };
  }

  const score = total ? Math.round((correct / total) * 1000) / 10 : 0;
  const passed = score >= (course?.pass_threshold ?? 80);
  await db.execute({
    sql: `UPDATE training_attempts SET status = 'completed', final_score = ?, final_passed = ?, completed_at = now() WHERE id = ?`,
    args: [score, passed, attemptId]
  });

  return { correct, total, pendingReview, status: 'completed', score, passed };
}

// Every free_text answer still awaiting a human tick, across every course
// and learner, oldest-answered first within each person — grouped in the
// frontend by attempt_id so a reviewer works through one person's
// submission at a time instead of a flat, context-less list.
async function listPendingReviews() {
  const db = getDb();
  const res = await db.execute(`
    SELECT ta.id AS answer_id, ta.attempt_id, ta.selected_answer, ta.answered_at,
           tq.question_text, tq.correct_answer AS reference_answer, tq.module_id,
           att.user_email, att.course_id, att.status AS attempt_status,
           tc.title AS course_title, tm.title AS module_title
    FROM training_answers ta
    JOIN training_questions tq ON tq.id = ta.question_id
    JOIN training_attempts att ON att.id = ta.attempt_id
    JOIN training_courses tc ON tc.id = att.course_id
    LEFT JOIN training_modules tm ON tm.id = tq.module_id
    WHERE tq.question_type = 'free_text' AND ta.is_correct IS NULL
    ORDER BY att.user_email ASC, ta.answered_at ASC
  `);
  return res.rows;
}

// Sophia/Joy ticking one free_text answer correct or incorrect. Once that
// clears every free_text answer on the FINAL ASSESSMENT of a pending_review
// attempt (module-level free_text answers don't gate this — they're
// practice feedback, same as module multiple_choice, and never fed
// final_score even before this feature existed), the real score gets
// computed and the attempt flips to completed.
async function reviewAnswer(answerId, isCorrect, reviewerEmail) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE training_answers SET is_correct = ?, reviewed_by = ?, reviewed_at = now() WHERE id = ?`,
    args: [!!isCorrect, reviewerEmail, answerId]
  });
  const answerRes = await db.execute({ sql: 'SELECT * FROM training_answers WHERE id = ?', args: [answerId] });
  const answer = answerRes.rows[0];
  if (!answer) return null;
  await maybeFinalizeAttempt(answer.attempt_id);
  return answer;
}

async function maybeFinalizeAttempt(attemptId) {
  const db = getDb();
  const attempt = await getAttempt(attemptId);
  if (!attempt || attempt.status !== 'pending_review') return;

  const questionsRes = await db.execute({ sql: 'SELECT id FROM training_questions WHERE course_id = ? AND module_id IS NULL', args: [attempt.course_id] });
  const answersRes = await db.execute({ sql: 'SELECT * FROM training_answers WHERE attempt_id = ?', args: [attemptId] });
  const finalQuestionIds = new Set(questionsRes.rows.map(q => q.id));
  const finalAnswers = answersRes.rows.filter(a => finalQuestionIds.has(a.question_id));
  if (finalAnswers.some(a => a.is_correct === null)) return; // still someone left to review

  const courseRes = await db.execute({ sql: 'SELECT * FROM training_courses WHERE id = ?', args: [attempt.course_id] });
  const course = courseRes.rows[0];
  const correct = finalAnswers.filter(a => a.is_correct).length;
  const total = finalAnswers.length;
  const score = total ? Math.round((correct / total) * 1000) / 10 : 0;
  const passed = score >= (course?.pass_threshold ?? 80);
  await db.execute({
    sql: `UPDATE training_attempts SET status = 'completed', final_score = ?, final_passed = ?, completed_at = now() WHERE id = ?`,
    args: [score, passed, attemptId]
  });
}

// Merges assignments and attempts by user so someone who's been assigned
// the course but hasn't started it yet still shows up (as "not started"
// with their due date) instead of being invisible until their first
// attempt exists.
async function getCourseResults(courseId) {
  const db = getDb();
  const [attemptsRes, assignRes] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM training_attempts WHERE course_id = ? ORDER BY started_at DESC', args: [courseId] }),
    db.execute({ sql: 'SELECT * FROM training_assignments WHERE course_id = ?', args: [courseId] })
  ]);

  const byEmail = new Map();
  for (const a of assignRes.rows) {
    byEmail.set(a.user_email, {
      user_email: a.user_email, status: 'not_started', final_score: null, final_passed: null,
      started_at: null, due_date: a.due_date, assigned_by_name: a.assigned_by_name, is_assigned: true
    });
  }
  const seenAttempt = new Set();
  for (const at of attemptsRes.rows) {
    if (seenAttempt.has(at.user_email)) continue; // newest attempt wins (already sorted DESC)
    seenAttempt.add(at.user_email);
    const existing = byEmail.get(at.user_email) || { user_email: at.user_email, due_date: null, assigned_by_name: null, is_assigned: false };
    byEmail.set(at.user_email, {
      ...existing, status: at.status, final_score: at.final_score,
      final_passed: at.final_passed, started_at: at.started_at, attempt_id: at.id
    });
  }
  // started_at comes back as a Date object (or null), not a string.
  return Array.from(byEmail.values()).sort((a, b) => (b.started_at ? b.started_at.getTime() : 0) - (a.started_at ? a.started_at.getTime() : 0));
}

// Full per-module and per-question breakdown for one attempt — module_results
// (correct/total per module, saved as each module is submitted) plus the
// individual answers so an admin can see exactly which questions someone
// got wrong, not just the aggregate score.
async function getAttemptDetail(attemptId) {
  const db = getDb();
  const attempt = await getAttempt(attemptId);
  if (!attempt) return null;

  const [course, modulesRes, questionsRes, answersRes] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM training_courses WHERE id = ?', args: [attempt.course_id] }).then(r => r.rows[0]),
    db.execute({ sql: 'SELECT * FROM training_modules WHERE course_id = ? ORDER BY order_index ASC', args: [attempt.course_id] }),
    db.execute({ sql: 'SELECT * FROM training_questions WHERE course_id = ? ORDER BY order_index ASC', args: [attempt.course_id] }),
    db.execute({ sql: 'SELECT * FROM training_answers WHERE attempt_id = ?', args: [attemptId] })
  ]);

  const answerByQuestionId = new Map(answersRes.rows.map(a => [a.question_id, a]));
  const moduleResultByModuleId = new Map((attempt.module_results || []).map(mr => [mr.moduleId, mr]));

  function withAnswers(questions) {
    return questions.map(q => {
      const a = answerByQuestionId.get(q.id);
      // is_correct stays null (not false) for a free_text answer nobody's
      // reviewed yet — collapsing it to false would show an honestly-pending
      // answer as wrong.
      const isCorrect = a ? a.is_correct : false;
      return {
        question_text: q.question_text, question_type: q.question_type, options: q.options, correct_answer: q.correct_answer,
        selected_answer: a?.selected_answer ?? null, is_correct: isCorrect, answered: !!a,
        pending_review: !!a && q.question_type === 'free_text' && a.is_correct === null
      };
    });
  }

  const modules = modulesRes.rows.map(m => {
    const questions = questionsRes.rows.filter(q => q.module_id === m.id);
    const mr = moduleResultByModuleId.get(m.id);
    return { id: m.id, title: m.title, correct: mr?.correct ?? null, total: mr?.total ?? questions.length, questions: withAnswers(questions) };
  });
  const finalQuestions = questionsRes.rows.filter(q => !q.module_id);

  return {
    course_title: course?.title, user_email: attempt.user_email, status: attempt.status,
    final_score: attempt.final_score, final_passed: attempt.final_passed,
    modules, finalAssessment: withAnswers(finalQuestions)
  };
}

// Assigns a course to specific people, upserting so re-assigning someone
// (e.g. to change their due date) doesn't create a duplicate row.
async function assignCourse(courseId, emails, dueDate, assignedByEmail, assignedByName) {
  const db = getDb();
  const courseRes = await db.execute({ sql: 'SELECT id FROM training_courses WHERE id = ?', args: [courseId] });
  if (!courseRes.rows[0]) throw new Error('Course not found');
  for (const email of emails) {
    await db.execute({
      sql: `INSERT INTO training_assignments (id, course_id, user_email, due_date, assigned_by_email, assigned_by_name)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (course_id, user_email) DO UPDATE SET due_date = EXCLUDED.due_date, assigned_by_email = EXCLUDED.assigned_by_email, assigned_by_name = EXCLUDED.assigned_by_name`,
      args: [uuidv4(), courseId, email, dueDate || null, assignedByEmail || null, assignedByName || null]
    });
  }
  return emails.length;
}

// Deletes a single attempt (and its answers), letting that person start
// the course fresh — clears both a stuck in-progress attempt and a
// completed score.
async function deleteAttempt(attemptId) {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM training_answers WHERE attempt_id = ?', args: [attemptId] });
  await db.execute({ sql: 'DELETE FROM training_attempts WHERE id = ?', args: [attemptId] });
}

// Deletes every attempt a person has made on a course, in case they have
// more than one (e.g. an old completed run plus a stuck in-progress one).
async function resetUserAttempts(courseId, userEmail) {
  const db = getDb();
  const attempts = await db.execute({
    sql: 'SELECT id FROM training_attempts WHERE course_id = ? AND user_email = ?',
    args: [courseId, userEmail]
  });
  for (const a of attempts.rows) {
    await deleteAttempt(a.id);
  }
  return attempts.rows.length;
}

module.exports = {
  generateCourseFromMaterial,
  gatherCourseContext,
  saveCourse,
  listCourses,
  getCourseDetail,
  updateCourse,
  deleteCourse,
  updateModule,
  deleteModule,
  updateQuestion,
  deleteQuestion,
  startAttempt,
  getAttempt,
  submitModuleAnswers,
  submitFinalAssessment,
  getCourseResults,
  deleteAttempt,
  resetUserAttempts,
  assignCourse,
  getAttemptDetail,
  listPendingReviews,
  reviewAnswer
};
