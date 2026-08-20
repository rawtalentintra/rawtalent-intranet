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
const PRIORITY_OVERRIDES = new Set(['top', 'high', 'normal', 'low']);

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
        ) ORDER BY pm.order_index ASC, pm.id ASC) AS milestones
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
        sql: 'SELECT id, name, start_date AS "startDate", end_date AS "endDate" FROM project_milestones WHERE project_id = ? ORDER BY order_index ASC, id ASC',
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

    const maxRes = await db.execute({
      sql: 'SELECT COALESCE(MAX(order_index), -1) AS max_order FROM project_milestones WHERE project_id = ?',
      args: [req.params.id]
    });
    const nextOrder = Number(maxRes.rows[0].max_order) + 1;

    const result = await db.execute({
      sql: 'INSERT INTO project_milestones (project_id, name, start_date, end_date, order_index) VALUES (?, ?, ?, ?, ?) RETURNING id',
      args: [req.params.id, name.trim(), startDate || null, endDate || null, nextOrder]
    });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { order: [milestoneId, ...] } in the desired display order — every
// id's order_index becomes its position in that array. Scoped to :id so a
// stray/forged id from another project can't have its order reshuffled by
// a request for a different project.
router.put('/:id/milestones/reorder', async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of milestone ids' });
  try {
    const db = getDb();
    for (let i = 0; i < order.length; i++) {
      await db.execute({
        sql: 'UPDATE project_milestones SET order_index = ?, updated_at = now() WHERE id = ? AND project_id = ?',
        args: [i, order[i], req.params.id]
      });
    }
    res.json({ success: true });
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

// Request-body key -> column name, in the order they should appear in SET.
const PROJECT_FIELD_COLUMNS = {
  name: 'name', icon: 'icon', color: 'color', description: 'description',
  status: 'status', ownerName: 'owner_name', ownerEmail: 'owner_email',
  startDate: 'start_date', targetDate: 'target_date',
  successCriteria: 'success_criteria', sopContent: 'sop_content',
  priorityOverride: 'priority_override'
};

router.put('/:id', async (req, res) => {
  const body = req.body || {};
  if (body.status && !STATUSES.has(body.status)) return res.status(400).json({ error: 'Invalid status' });
  // priorityOverride is nullable (null/'' clears back to auto), so only
  // validate when a non-empty value was actually sent.
  if (body.priorityOverride && !PRIORITY_OVERRIDES.has(body.priorityOverride)) return res.status(400).json({ error: 'Invalid priority' });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT id FROM projects WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Project not found' });

    // Only touch columns whose key is actually present in the request body
    // — a caller that only wants to change one thing (e.g. the SOP editor's
    // save, which sends just { sopContent }) must never wipe every other
    // field to NULL just by omitting it. This also means an explicit
    // `startDate: null` (the full edit form's way of clearing a date) still
    // works, since the key IS present, just with a null value.
    const setClauses = [];
    const args = [];
    for (const [key, column] of Object.entries(PROJECT_FIELD_COLUMNS)) {
      if (!(key in body)) continue;
      let value = body[key];
      if (key === 'name') value = value?.trim() || null;
      setClauses.push(`${column} = ?`);
      args.push(value);
    }
    if (setClauses.length) {
      setClauses.push('updated_at = now()');
      args.push(req.params.id);
      await db.execute({ sql: `UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`, args });
    }
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
