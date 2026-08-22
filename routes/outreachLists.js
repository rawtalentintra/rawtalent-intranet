const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireOutreachListBuilder } = require('../middleware/authMiddleware');
const { getDb, transaction } = require('../db/database');
const { logActivity } = require('../services/activityLog');

// Educator Outreach list builder (Decision Area 1, 2026-08-22) —
// create/name/view/edit-membership/export only. HeartBeat has no send
// capability yet, so there's deliberately no send/approval endpoint here —
// see db/schema.sql's comment on educator_outreach_lists for what to add
// when that feature is actually built.
router.use(requireAuth, requireOutreachListBuilder);

router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT l.id, l.name, l.purpose, l.source_pod_id AS "sourcePodId", l.source_segment AS "sourceSegment",
              l.created_by AS "createdBy", l.created_at AS "createdAt", l.updated_at AS "updatedAt",
              count(m.user_id)::int AS "memberCount"
            FROM educator_outreach_lists l
            LEFT JOIN educator_outreach_list_members m ON m.list_id = l.id
            GROUP BY l.id
            ORDER BY l.created_at DESC`,
      args: []
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const listRes = await db.execute({
      sql: `SELECT id, name, purpose, source_pod_id AS "sourcePodId", source_segment AS "sourceSegment",
              created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
            FROM educator_outreach_lists WHERE id = ?`,
      args: [req.params.id]
    });
    const list = listRes.rows[0];
    if (!list) return res.status(404).json({ error: 'List not found' });

    const membersRes = await db.execute({
      sql: `SELECT user_id AS "userId", name, email, contact_no AS "contactNo", suburb, segment, added_at AS "addedAt"
            FROM educator_outreach_list_members WHERE list_id = ? ORDER BY name`,
      args: [req.params.id]
    });
    res.json({ ...list, members: membersRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// members: [{ userId, name, email, contactNo, suburb, segment }, ...] — a
// frozen snapshot at build time (see schema.sql's comment on
// educator_outreach_list_members for why this isn't a live join).
router.post('/', async (req, res) => {
  const { name, purpose, sourcePodId, sourceSegment, members } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'At least one educator is required' });

  try {
    const id = uuidv4();
    await transaction(async db => {
      await db.execute({
        sql: `INSERT INTO educator_outreach_lists (id, name, purpose, source_pod_id, source_segment, created_by)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [id, name.trim(), purpose || null, sourcePodId || null, sourceSegment || null, req.user.email]
      });
      const values = [];
      const rows = [];
      for (const m of members) {
        if (!m.userId) continue;
        rows.push('(?, ?, ?, ?, ?, ?, ?)');
        values.push(id, m.userId, m.name || null, m.email || null, m.contactNo || null, m.suburb || null, m.segment || null);
      }
      if (rows.length) {
        await db.execute({
          sql: `INSERT INTO educator_outreach_list_members (list_id, user_id, name, email, contact_no, suburb, segment)
                VALUES ${rows.join(', ')} ON CONFLICT (list_id, user_id) DO NOTHING`,
          args: values
        });
      }
    });
    await logActivity('outreach_list', name.trim(), 'created', `List "${name.trim()}" created with ${members.length} educator(s)`, req.user.email);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/members', async (req, res) => {
  const { members } = req.body;
  if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'At least one educator is required' });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT id, name FROM educator_outreach_lists WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'List not found' });

    const values = [];
    const rows = [];
    for (const m of members) {
      if (!m.userId) continue;
      rows.push('(?, ?, ?, ?, ?, ?, ?)');
      values.push(req.params.id, m.userId, m.name || null, m.email || null, m.contactNo || null, m.suburb || null, m.segment || null);
    }
    if (rows.length) {
      await db.execute({
        sql: `INSERT INTO educator_outreach_list_members (list_id, user_id, name, email, contact_no, suburb, segment)
              VALUES ${rows.join(', ')} ON CONFLICT (list_id, user_id) DO NOTHING`,
        args: values
      });
      await db.execute({ sql: 'UPDATE educator_outreach_lists SET updated_at = now() WHERE id = ?', args: [req.params.id] });
    }
    await logActivity('outreach_list', existing.rows[0].name, 'updated', `${members.length} educator(s) added`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT id, name FROM educator_outreach_lists WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'List not found' });
    await db.execute({
      sql: 'DELETE FROM educator_outreach_list_members WHERE list_id = ? AND user_id = ?',
      args: [req.params.id, req.params.userId]
    });
    await db.execute({ sql: 'UPDATE educator_outreach_lists SET updated_at = now() WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Creator, or admin/super_admin, may delete — otherwise anyone with the
// grant could delete anyone else's saved list.
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT id, name, created_by AS "createdBy" FROM educator_outreach_lists WHERE id = ?', args: [req.params.id] });
    const list = existing.rows[0];
    if (!list) return res.status(404).json({ error: 'List not found' });
    const isOwner = list.createdBy.toLowerCase() === req.user.email.toLowerCase();
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Only the creator or an admin can delete this list' });

    await db.execute({ sql: 'DELETE FROM educator_outreach_lists WHERE id = ?', args: [req.params.id] });
    await logActivity('outreach_list', list.name, 'deleted', `List "${list.name}" deleted`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
