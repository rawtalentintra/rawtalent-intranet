const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireAuth, requireAdmin, requireSuperAdmin, requireTrainingBuilder } = require('../middleware/authMiddleware');
const { extractPlainText } = require('../services/documentTextExtractor');
const training = require('../services/trainingService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function isStaff(role) { return role === 'admin' || role === 'super_admin'; }

// Training Dashboard (read-only: course list, detail, results) and taking a
// course are open to every signed-in user — assigning a course to someone
// only helps if they can actually see and take it. Building/editing/
// publishing/deleting a course is gated to super_admin or whoever has the
// per-user can_build_training flag (see requireTrainingBuilder) — assigning
// a course stays super_admin only regardless,
// gated per-route below.
router.use(requireAuth);

router.get('/courses', async (req, res) => {
  try {
    const courses = await training.listCourses(req.user.email);
    // Regular staff only ever see live courses (their own assignments and
    // attempts are still merged in regardless of status). Admins/super
    // admins see everything, including drafts, same as before.
    const visible = isStaff(req.user.role) ? courses : courses.filter(c => c.status === 'live' || c.my_assignment);
    res.json(visible);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/courses/:id', async (req, res) => {
  try {
    const course = await training.getCourseDetail(req.params.id, req.user.email);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (course.status !== 'live' && !isStaff(req.user.role) && !course.my_assignment) return res.status(404).json({ error: 'Course not found' });
    res.json(course);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/courses/:id/results', requireAdmin, async (req, res) => {
  try {
    res.json(await training.getCourseResults(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push a course to specific people, with an optional due date.
router.post('/courses/:id/assign', requireSuperAdmin, async (req, res) => {
  const { emails, due_date } = req.body;
  if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: 'Pick at least one person' });
  try {
    const count = await training.assignCourse(req.params.id, emails, due_date, req.user.email, req.user.name || req.user.email);
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change one person's due date on an existing assignment — same upsert as
// /assign, just scoped to a single already-assigned person.
router.patch('/courses/:id/assignments/:userEmail', requireSuperAdmin, async (req, res) => {
  try {
    await training.assignCourse(req.params.id, [decodeURIComponent(req.params.userEmail)], req.body.due_date, req.user.email, req.user.name || req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accepts either a pasted `material` string or one or more uploaded
// documents (pdf/docx/txt) — uploaded files win over pasted text if both
// are present. Each file's text is kept under a heading naming the source
// file, so the model can tell where one document ends and the next begins.
router.post('/courses/generate', requireTrainingBuilder, upload.array('documents', 10), async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Course title is required' });

    let material = req.body.material || '';
    if (req.files?.length) {
      const extracted = await Promise.all(req.files.map(async f => {
        const text = await extractPlainText(f.buffer, f.originalname);
        return `--- ${f.originalname} ---\n${text}`;
      }));
      material = extracted.join('\n\n');
    }
    if (!material.trim()) return res.status(400).json({ error: 'Paste the training material or upload a document' });

    const course = await training.generateCourseFromMaterial({
      title: title.trim(),
      description: description?.trim() || '',
      material,
      createdBy: req.user.email
    });
    res.json(course);
  } catch (err) {
    console.error('Training generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/courses/:id', requireTrainingBuilder, async (req, res) => {
  try {
    await training.updateCourse(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/courses/:id', requireTrainingBuilder, async (req, res) => {
  try {
    await training.deleteCourse(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/modules/:moduleId', requireTrainingBuilder, async (req, res) => {
  try {
    await training.updateModule(req.params.moduleId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/modules/:moduleId', requireTrainingBuilder, async (req, res) => {
  try {
    await training.deleteModule(req.params.moduleId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/questions/:questionId', requireTrainingBuilder, async (req, res) => {
  try {
    await training.updateQuestion(req.params.questionId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/questions/:questionId', requireTrainingBuilder, async (req, res) => {
  try {
    await training.deleteQuestion(req.params.questionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Taking a course — open to any signed-in user, same as the read-only
// routes above ──
router.post('/courses/:id/attempts', async (req, res) => {
  try {
    const course = await training.getCourseDetail(req.params.id, req.user.email);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (course.status !== 'live' && !isStaff(req.user.role) && !course.my_assignment) return res.status(404).json({ error: 'Course not found' });
    const attempt = await training.startAttempt(req.params.id, req.user.email);
    res.json(attempt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/attempts/:id', async (req, res) => {
  try {
    const attempt = await training.getAttempt(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    res.json(attempt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-module and per-question breakdown for one attempt — same audience as
// the results table itself (admin + super_admin).
router.get('/attempts/:id/detail', requireAdmin, async (req, res) => {
  try {
    const detail = await training.getAttemptDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Attempt not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/attempts/:id/modules/:moduleId/answers', async (req, res) => {
  try {
    const result = await training.submitModuleAnswers(req.params.id, req.params.moduleId, req.body.answers || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/attempts/:id/final', async (req, res) => {
  try {
    const result = await training.submitFinalAssessment(req.params.id, req.body.answers || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset a person's course progress — deletes every attempt they have on
// this course so their next "Take Course" starts completely fresh.
router.delete('/courses/:id/results/:userEmail', requireSuperAdmin, async (req, res) => {
  try {
    const count = await training.resetUserAttempts(req.params.id, decodeURIComponent(req.params.userEmail));
    res.json({ success: true, attemptsRemoved: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
