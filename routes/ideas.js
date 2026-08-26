const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { BUCKETS, uploadBase64, downloadAsBuffer, ensureBucket, parseDataUri, extForMimetype, setFileResponseHeaders } = require('../services/storageService');

// Pasted/attached screenshots only — not a general file-attachment feature,
// so a plain image-count cap is enough (no need for a size config knob).
const MAX_IDEA_IMAGES = 4;

router.use(requireAuth);

// Everyone sees every idea and who submitted it — it's a team suggestion
// box, not an anonymous inbox.
router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute(`
      SELECT i.*, COALESCE(f.files, '[]'::json) AS files
      FROM ideas i
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'id', ifi.id, 'filename', ifi.filename, 'mimetype', ifi.mimetype
        ) ORDER BY ifi.created_at ASC) AS files
        FROM idea_files ifi WHERE ifi.idea_id = i.id
      ) f ON true
      ORDER BY i.created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, description, images } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Give your idea a title' });

    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO ideas (id, title, description, submitted_by_email, submitted_by_name)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, title.trim(), description?.trim() || null, req.user.email, req.user.name || req.user.email]
    });

    if (Array.isArray(images) && images.length) {
      const db = getDb();
      await ensureBucket(BUCKETS.ideaFiles);
      for (const dataUri of images.slice(0, MAX_IDEA_IMAGES)) {
        const parsed = parseDataUri(dataUri);
        if (!parsed || !parsed.mimetype.startsWith('image/')) continue;
        const fileResult = await db.execute({
          sql: 'INSERT INTO idea_files (idea_id, filename, mimetype, filesize) VALUES (?, ?, ?, ?) RETURNING id',
          args: [id, `pasted-image.${extForMimetype(parsed.mimetype)}`, parsed.mimetype, Buffer.byteLength(parsed.base64, 'base64')]
        });
        const fileId = fileResult.rows[0].id;
        const storagePath = `${fileId}.${extForMimetype(parsed.mimetype)}`;
        await uploadBase64(BUCKETS.ideaFiles, storagePath, parsed.base64, parsed.mimetype);
        await db.execute({ sql: 'UPDATE idea_files SET storage_path = ? WHERE id = ?', args: [storagePath, fileId] });
      }
    }

    const result = await getDb().execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [id] });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/file/:fileId', async (req, res) => {
  try {
    const file = (await getDb().execute({ sql: 'SELECT * FROM idea_files WHERE id = ?', args: [req.params.fileId] })).rows[0];
    if (!file || !file.storage_path) return res.status(404).json({ error: 'File not found' });
    const buffer = await downloadAsBuffer(BUCKETS.ideaFiles, file.storage_path);
    setFileResponseHeaders(res, { mimetype: file.mimetype, filename: file.filename, wantInline: true });
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin moves status along and/or leaves feedback — only these two fields,
// not the original title/description, so the submitter's own wording stays
// intact as the record of what they actually asked for.
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { status, adminFeedback } = req.body;
    const validStatuses = ['new', 'in_review', 'in_progress', 'implemented', 'not_planned'];
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    await getDb().execute({
      sql: `UPDATE ideas SET status = COALESCE(?, status), admin_feedback = COALESCE(?, admin_feedback), updated_at = now() WHERE id = ?`,
      args: [status || null, adminFeedback ?? null, req.params.id]
    });
    const result = await getDb().execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Idea not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
