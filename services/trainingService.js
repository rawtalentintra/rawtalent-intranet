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
function buildGenerationTool() {
  const question = {
    type: 'object',
    properties: {
      questionText: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
      correctAnswer: { type: 'string', description: 'Must exactly match one of the strings in options.' }
    },
    required: ['questionText', 'options', 'correctAnswer']
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
              questions: { type: 'array', minItems: 1, maxItems: 3, items: question, description: 'Comprehension check questions asked right after this module.' }
            },
            required: ['title', 'content', 'questions']
          }
        },
        finalAssessment: {
          type: 'array',
          minItems: 5,
          items: question,
          description: 'Graded assessment questions drawn across all modules, testing retention of the material as a whole.'
        }
      },
      required: ['modules', 'finalAssessment']
    }
  };
}

async function generateCourseFromMaterial({ title, description, material, createdBy }) {
  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');
  if (!material?.trim()) throw new Error('Source material is required to generate a course.');

  const db = getDb();
  const contextBlock = await gatherCourseContext(db, title, description);

  const tool = buildGenerationTool();
  const system = `You are building internal staff training for RawTalent, an Australian childcare staffing agency. Given raw source material (a process doc, SOP, or reference sheet) plus supplementary context pulled from RawTalent's own knowledge base (internal articles, AI sources, FAQs, glossary, and real call-evaluation/calibration data), break the material into a logical sequence of study modules a new consultant can work through — each module should cover one coherent chunk of the material (e.g. one process, one concept area), not an arbitrary page split.

The uploaded/pasted source material is the SPINE of the course — build modules from it directly. Use the supplementary context to enrich and correct that content: apply glossary terms precisely wherever they're relevant, fold in directly relevant detail from related articles/FAQs/AI sources where it fills a gap the source material leaves open, and — where the call-evaluation themes or calibration notes surface a common real mistake related to this topic — make sure a module or question addresses it. Don't force in unrelated context just because it was provided; only use what's actually relevant to this course's material.

After each module, write 1-3 multiple-choice comprehension questions that check whether the learner actually understood THAT module's content — plausible wrong answers, not trick questions. Then write a final assessment of at least 5 multiple-choice questions drawing across the whole course, testing real retention. Write everything in clear, formal Australian English. Call submit_course exactly once.`;

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
    messages: [{ role: 'user', content: `Course title: ${title}\n${description ? `Course description: ${description}\n` : ''}\nSource material:\n${material.slice(0, 30000)}${contextBlock ? `\n\n---\n# Supplementary RawTalent Knowledge Base Context\n${contextBlock.slice(0, 15000)}` : ''}` }]
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
      await db.execute({
        sql: `INSERT INTO training_questions (id, course_id, module_id, question_text, options, correct_answer, order_index)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [uuidv4(), courseId, moduleId, q.questionText, JSON.stringify(q.options), q.correctAnswer, qi]
      });
    }
  }

  for (let qi = 0; qi < generated.finalAssessment.length; qi++) {
    const q = generated.finalAssessment[qi];
    await db.execute({
      sql: `INSERT INTO training_questions (id, course_id, module_id, question_text, options, correct_answer, order_index)
            VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      args: [uuidv4(), courseId, q.questionText, JSON.stringify(q.options), q.correctAnswer, qi]
    });
  }

  return getCourseDetail(courseId);
}

// ── CRUD ────────────────────────────────────────────────────────
async function listCourses() {
  const db = getDb();
  const coursesRes = await db.execute('SELECT * FROM training_courses ORDER BY created_at DESC');
  const attemptsRes = await db.execute(`
    SELECT course_id, COUNT(*) AS attempts, COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE final_passed = true) AS passed
    FROM training_attempts GROUP BY course_id`);
  const modulesRes = await db.execute('SELECT course_id, COUNT(*) AS module_count FROM training_modules GROUP BY course_id');
  const statsByCourseId = new Map(attemptsRes.rows.map(r => [r.course_id, r]));
  const moduleCountByCourseId = new Map(modulesRes.rows.map(r => [r.course_id, Number(r.module_count)]));
  return coursesRes.rows.map(c => ({
    ...c,
    module_count: moduleCountByCourseId.get(c.id) || 0,
    stats: statsByCourseId.get(c.id) || { attempts: 0, completed: 0, passed: 0 }
  }));
}

async function getCourseDetail(courseId) {
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
  return { ...course, modules, finalAssessment };
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

async function updateQuestion(questionId, { questionText, options, correctAnswer }) {
  const db = getDb();
  const fields = [];
  const args = [];
  if (questionText !== undefined) { fields.push('question_text = ?'); args.push(questionText); }
  if (options !== undefined) { fields.push('options = ?'); args.push(JSON.stringify(options)); }
  if (correctAnswer !== undefined) { fields.push('correct_answer = ?'); args.push(correctAnswer); }
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

function gradeAnswers(questions, submittedAnswers) {
  let correct = 0;
  const results = questions.map(q => {
    const given = submittedAnswers[q.id];
    const isCorrect = given === q.correct_answer;
    if (isCorrect) correct++;
    return { questionId: q.id, given, correct: isCorrect };
  });
  return { correct, total: questions.length, results };
}

async function submitModuleAnswers(attemptId, moduleId, answers) {
  const db = getDb();
  const attempt = await getAttempt(attemptId);
  if (!attempt) throw new Error('Attempt not found');

  const questionsRes = await db.execute({ sql: 'SELECT * FROM training_questions WHERE module_id = ? ORDER BY order_index ASC', args: [moduleId] });
  const { correct, total, results } = gradeAnswers(questionsRes.rows, answers);

  for (const r of results) {
    await db.execute({
      sql: `INSERT INTO training_answers (id, attempt_id, question_id, selected_answer, is_correct) VALUES (?, ?, ?, ?, ?)`,
      args: [uuidv4(), attemptId, r.questionId, r.given ?? null, r.correct]
    });
  }

  const moduleResults = Array.isArray(attempt.module_results) ? attempt.module_results : [];
  moduleResults.push({ moduleId, correct, total });
  await db.execute({
    sql: `UPDATE training_attempts SET module_results = ?, current_module_index = current_module_index + 1 WHERE id = ?`,
    args: [JSON.stringify(moduleResults), attemptId]
  });

  return { correct, total, results };
}

async function submitFinalAssessment(attemptId, answers) {
  const db = getDb();
  const attempt = await getAttempt(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  const courseRes = await db.execute({ sql: 'SELECT * FROM training_courses WHERE id = ?', args: [attempt.course_id] });
  const course = courseRes.rows[0];

  const questionsRes = await db.execute({ sql: 'SELECT * FROM training_questions WHERE course_id = ? AND module_id IS NULL ORDER BY order_index ASC', args: [attempt.course_id] });
  const { correct, total, results } = gradeAnswers(questionsRes.rows, answers);

  for (const r of results) {
    await db.execute({
      sql: `INSERT INTO training_answers (id, attempt_id, question_id, selected_answer, is_correct) VALUES (?, ?, ?, ?, ?)`,
      args: [uuidv4(), attemptId, r.questionId, r.given ?? null, r.correct]
    });
  }

  const score = total ? Math.round((correct / total) * 1000) / 10 : 0;
  const passed = score >= (course?.pass_threshold ?? 80);
  await db.execute({
    sql: `UPDATE training_attempts SET status = 'completed', final_score = ?, final_passed = ?, completed_at = now() WHERE id = ?`,
    args: [score, passed, attemptId]
  });

  return { correct, total, score, passed };
}

async function getCourseResults(courseId) {
  const res = await getDb().execute({
    sql: `SELECT * FROM training_attempts WHERE course_id = ? ORDER BY started_at DESC`,
    args: [courseId]
  });
  return res.rows;
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
  getCourseResults
};
