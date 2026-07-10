const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const { logActivity } = require('../services/activityLog');

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Real PII (home address, birthdate, personal device/backup details) —
// same confidentiality gate as Users management.
router.use(requireSuperAdmin);

router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM team_members ORDER BY sort_order ASC, name ASC');
    res.json(result.rows.map(r => ({ ...r, backup_types: r.backup_types ? JSON.parse(r.backup_types) : [] })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { name, legal_name, position, team, manager_id, sort_order, photo, employment_date, address, birthdate,
    phone, whatsapp, email, device_name, headset, internet_connection, backup_available, backup_types, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO team_members
            (id, name, legal_name, position, team, manager_id, sort_order, photo, employment_date, address, birthdate,
             phone, whatsapp, email, device_name, headset, internet_connection, backup_available, backup_types, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, name.trim(), legal_name || null, position || null, team || null, manager_id || null, sort_order || 0,
        photo || null, employment_date || null, address || null, birthdate || null, phone || null, whatsapp || null,
        email || null, device_name || null, headset || null, internet_connection || null, backup_available || null,
        JSON.stringify(backup_types || []), status || 'active'
      ]
    });
    await logActivity('team_member', name.trim(), 'created', `Team member "${name.trim()}" added`, req.user.email);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, legal_name, position, team, manager_id, sort_order, photo, employment_date, address, birthdate,
    phone, whatsapp, email, device_name, headset, internet_connection, backup_available, backup_types, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    await getDb().execute({
      sql: `UPDATE team_members SET
              name=?, legal_name=?, position=?, team=?, manager_id=?, sort_order=?, photo=?, employment_date=?,
              address=?, birthdate=?, phone=?, whatsapp=?, email=?, device_name=?, headset=?, internet_connection=?,
              backup_available=?, backup_types=?, status=?, updated_at=datetime('now')
            WHERE id=?`,
      args: [
        name.trim(), legal_name || null, position || null, team || null, manager_id || null, sort_order || 0,
        photo || null, employment_date || null, address || null, birthdate || null, phone || null, whatsapp || null,
        email || null, device_name || null, headset || null, internet_connection || null, backup_available || null,
        JSON.stringify(backup_types || []), status || 'active', req.params.id
      ]
    });
    await logActivity('team_member', name.trim(), 'updated', `Team member "${name.trim()}" edited`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT name FROM team_members WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM team_members WHERE id = ?', args: [req.params.id] });
    // Orphaned reports become top-level rather than vanishing from the chart.
    await db.execute({ sql: 'UPDATE team_members SET manager_id = NULL WHERE manager_id = ?', args: [req.params.id] });
    if (existing.rows[0]) await logActivity('team_member', existing.rows[0].name, 'deleted', `Team member "${existing.rows[0].name}" removed`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/photo', photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await getDb().execute({ sql: "UPDATE team_members SET photo = ?, updated_at = datetime('now') WHERE id = ?", args: [dataUri, req.params.id] });
    res.json({ success: true, photo: dataUri });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
