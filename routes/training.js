const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const { extractPlainText } = require('../services/documentTextExtractor');
const training = require('../services/trainingService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Training Hub is super_admin only for now — nobody else can even see this
// nav section, let alone hit these routes.
router.use(requireSuperAdmin);

router.get('/courses', async (req, res) => {
  try {
    res.json(await training.listCourses());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/courses/:id', async (req, res) => {
  try {
    const course = await training.getCourseDetail(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    res.json(course);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accepts either a pasted `material` string or an uploaded document
// (pdf/docx/txt) — whichever is present wins.
router.post('/courses/generate', upload.single('document'), async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Course title is required' });

    let material = req.body.material || '';
    if (req.file) {
      material = await extractPlainText(req.file.buffer, req.file.originalname);
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

router.put('/courses/:id', async (req, res) => {
  try {
    await training.updateCourse(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/courses/:id', async (req, res) => {
  try {
    await training.deleteCourse(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/modules/:moduleId', async (req, res) => {
  try {
    await training.updateModule(req.params.moduleId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/modules/:moduleId', async (req, res) => {
  try {
    await training.deleteModule(req.params.moduleId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/questions/:questionId', async (req, res) => {
  try {
    await training.updateQuestion(req.params.questionId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/questions/:questionId', async (req, res) => {
  try {
    await training.deleteQuestion(req.params.questionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/courses/:id/results', async (req, res) => {
  try {
    res.json(await training.getCourseResults(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Taking a course (super_admin only, for now — same gate as everything
// else in this file, since nobody else can reach Training Hub yet) ──
router.post('/courses/:id/attempts', async (req, res) => {
  try {
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

module.exports = router;
