const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAdmin } = require('../middleware/authMiddleware');
const { BUCKETS, uploadBuffer, downloadAsBuffer, remove: removeFile, extForMimetype, ensureBucket } = require('../services/storageService');

const projectFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Internal Projects tracker — admin/super_admin only, enforced both here and
// by /admin itself already requiring that role to load the panel at all.
router.use(requireAdmin);

const STATUSES = new Set(['planning', 'on_track', 'at_risk', 'off_track', 'on_hold', 'completed']);

router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute(`
      SELECT p.*, COALESCE(f.file_count, 0) AS file_count, COALESCE(m.milestones, '[]'::json) AS milestones
      FROM projects p
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS file_count FROM project_files pf WHERE pf.project_id = p.id
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'id', pm.id, 'name', pm.name, 'startDate', pm.start_date, 'endDate', pm.end_date
        ) ORDER BY pm.start_date ASC NULLS LAST, pm.id ASC) AS milestones
        FROM project_milestones pm WHERE pm.project_id = p.id
      ) m ON true
      ORDER BY p.created_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const projRes = await db.execute({ sql: 'SELECT * FROM projects WHERE id = ?', args: [req.params.id] });
    const project = projRes.rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [filesRes, milestonesRes] = await Promise.all([
      db.execute({
        sql: 'SELECT id, filename, mimetype, filesize, created_at FROM project_files WHERE project_id = ? ORDER BY created_at ASC',
        args: [req.params.id]
      }),
      db.execute({
        sql: 'SELECT id, name, start_date AS "startDate", end_date AS "endDate" FROM project_milestones WHERE project_id = ? ORDER BY start_date ASC NULLS LAST, id ASC',
        args: [req.params.id]
      })
    ]);
    res.json({ ...project, files: filesRes.rows, milestones: milestonesRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/milestones', async (req, res) => {
  const { name, startDate, endDate } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Milestone name is required' });
  try {
    const db = getDb();
    const projRes = await db.execute({ sql: 'SELECT id FROM projects WHERE id = ?', args: [req.params.id] });
    if (!projRes.rows[0]) return res.status(404).json({ error: 'Project not found' });

    const result = await db.execute({
      sql: 'INSERT INTO project_milestones (project_id, name, start_date, end_date) VALUES (?, ?, ?, ?) RETURNING id',
      args: [req.params.id, name.trim(), startDate || null, endDate || null]
    });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/milestones/:milestoneId', async (req, res) => {
  const { name, startDate, endDate } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Milestone name is required' });
  try {
    const db = getDb();
    const result = await db.execute({
      sql: 'UPDATE project_milestones SET name = ?, start_date = ?, end_date = ?, updated_at = now() WHERE id = ?',
      args: [name.trim(), startDate || null, endDate || null, req.params.milestoneId]
    });
    if (!result.rowsAffected) return res.status(404).json({ error: 'Milestone not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/milestones/:milestoneId', async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM project_milestones WHERE id = ?', args: [req.params.milestoneId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { name, icon, color, description, status, ownerName, ownerEmail, startDate, targetDate, successCriteria } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  if (status && !STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO projects
            (id, name, icon, color, description, status, owner_name, owner_email, start_date, target_date, success_criteria, created_by_email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, name.trim(), icon || '🚀', color || '#3d6fff', description || null, status || 'planning',
        ownerName || null, ownerEmail || null, startDate || null, targetDate || null, successCriteria || null,
        req.user.email
      ]
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, icon, color, description, status, ownerName, ownerEmail, startDate, targetDate, successCriteria, sopContent } = req.body;
  if (status && !STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT id FROM projects WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Project not found' });

    await db.execute({
      sql: `UPDATE projects SET
              name = COALESCE(?, name),
              icon = COALESCE(?, icon),
              color = COALESCE(?, color),
              description = ?,
              status = COALESCE(?, status),
              owner_name = ?,
              owner_email = ?,
              start_date = ?,
              target_date = ?,
              success_criteria = ?,
              sop_content = COALESCE(?, sop_content),
              updated_at = now()
            WHERE id = ?`,
      args: [
        name?.trim() || null, icon || null, color || null, description ?? null, status || null,
        ownerName ?? null, ownerEmail ?? null, startDate ?? null, targetDate ?? null, successCriteria ?? null,
        sopContent ?? null,
        req.params.id
      ]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const filesRes = await db.execute({ sql: 'SELECT storage_path FROM project_files WHERE project_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [req.params.id] });
    for (const f of filesRes.rows) {
      if (f.storage_path) {
        try { await removeFile(BUCKETS.projectFiles, f.storage_path); } catch { /* orphaned storage object, non-fatal */ }
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/files', projectFileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = getDb();
    const projRes = await db.execute({ sql: 'SELECT id FROM projects WHERE id = ?', args: [req.params.id] });
    if (!projRes.rows[0]) return res.status(404).json({ error: 'Project not found' });

    const result = await db.execute({
      sql: 'INSERT INTO project_files (project_id, filename, mimetype, filesize) VALUES (?, ?, ?, ?) RETURNING id',
      args: [req.params.id, req.file.originalname, req.file.mimetype, req.file.size]
    });
    const fileId = result.rows[0].id;
    const storagePath = `${req.params.id}/${fileId}.${extForMimetype(req.file.mimetype)}`;
    await ensureBucket(BUCKETS.projectFiles);
    await uploadBuffer(BUCKETS.projectFiles, storagePath, req.file.buffer, req.file.mimetype);
    await db.execute({ sql: 'UPDATE project_files SET storage_path = ? WHERE id = ?', args: [storagePath, fileId] });

    res.json({ success: true, id: fileId, filename: req.file.originalname, filesize: req.file.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:fileId/download', async (req, res) => {
  try {
    const file = (await getDb().execute({ sql: 'SELECT * FROM project_files WHERE id = ?', args: [req.params.fileId] })).rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!file.storage_path) return res.status(404).json({ error: 'This file has no stored content' });
    const buffer = await downloadAsBuffer(BUCKETS.projectFiles, file.storage_path);
    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/files/:fileId', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT storage_path FROM project_files WHERE id = ?', args: [req.params.fileId] });
    await db.execute({ sql: 'DELETE FROM project_files WHERE id = ?', args: [req.params.fileId] });
    if (existing.rows[0]?.storage_path) {
      try { await removeFile(BUCKETS.projectFiles, existing.rows[0].storage_path); } catch { /* orphaned storage object, non-fatal */ }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
