const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');
const { logActivity } = require('../services/activityLog');
const { BUCKETS, uploadBase64, getSignedUrl, parseDataUri, extForMimetype } = require('../services/storageService');

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Viewable by any signed-in user (regardless of role) — editing (add/update/
// delete/photo) is super_admin only.
router.use(requireAuth);

// If the incoming `photo` field is a genuine new upload (a data: URI from
// the frontend's file picker), upload it to Storage and return the new
// path. Anything else (empty, or a signed URL echoed back unchanged because
// the form was saved without touching the photo) leaves the existing path
// untouched — a signed URL is not itself photo content to re-upload.
async function resolvePhotoStoragePath(photoField, existingPath, memberId) {
  const parsed = parseDataUri(photoField);
  if (!parsed) return existingPath ?? null;
  const path = `${memberId}.${extForMimetype(parsed.mimetype)}`;
  await uploadBase64(BUCKETS.teamPhotos, path, parsed.base64, parsed.mimetype);
  return path;
}

router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM team_members ORDER BY sort_order ASC, name ASC');
    // API contract keeps the `photo` field name for the frontend, but it's
    // now a short-lived signed URL rather than raw base64 — the bucket is
    // private, so nothing is servable without one.
    const rows = await Promise.all(result.rows.map(async ({ photo_storage_path, ...r }) => {
      let photo = null;
      if (photo_storage_path) {
        try { photo = await getSignedUrl(BUCKETS.teamPhotos, photo_storage_path); } catch { photo = null; }
      }
      return { ...r, photo, backup_types: r.backup_types || [] };
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireSuperAdmin, async (req, res) => {
  const { name, legal_name, position, team, manager_id, sort_order, photo, employment_date, address, birthdate,
    phone, whatsapp, email, emergency_contact_name, emergency_contact_number,
    device_name, headset, internet_connection, backup_available, backup_types, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const id = uuidv4();
    const photoStoragePath = await resolvePhotoStoragePath(photo, null, id);
    await getDb().execute({
      sql: `INSERT INTO team_members
            (id, name, legal_name, position, team, manager_id, sort_order, photo_storage_path, employment_date, address, birthdate,
             phone, whatsapp, email, emergency_contact_name, emergency_contact_number,
             device_name, headset, internet_connection, backup_available, backup_types, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, name.trim(), legal_name || null, position || null, team || null, manager_id || null, sort_order || 0,
        photoStoragePath, employment_date || null, address || null, birthdate || null, phone || null, whatsapp || null,
        email || null, emergency_contact_name || null, emergency_contact_number || null,
        device_name || null, headset || null, internet_connection || null, backup_available || null,
        JSON.stringify(backup_types || []), status || 'active'
      ]
    });
    await logActivity('team_member', name.trim(), 'created', `Team member "${name.trim()}" added`, req.user.email);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireSuperAdmin, async (req, res) => {
  const { name, legal_name, position, team, manager_id, sort_order, photo, employment_date, address, birthdate,
    phone, whatsapp, email, emergency_contact_name, emergency_contact_number,
    device_name, headset, internet_connection, backup_available, backup_types, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT photo_storage_path FROM team_members WHERE id = ?', args: [req.params.id] });
    const photoStoragePath = await resolvePhotoStoragePath(photo, existing.rows[0]?.photo_storage_path, req.params.id);
    await db.execute({
      sql: `UPDATE team_members SET
              name=?, legal_name=?, position=?, team=?, manager_id=?, sort_order=?, photo_storage_path=?, employment_date=?,
              address=?, birthdate=?, phone=?, whatsapp=?, email=?, emergency_contact_name=?, emergency_contact_number=?,
              device_name=?, headset=?, internet_connection=?,
              backup_available=?, backup_types=?, status=?, updated_at=now()
            WHERE id=?`,
      args: [
        name.trim(), legal_name || null, position || null, team || null, manager_id || null, sort_order || 0,
        photoStoragePath, employment_date || null, address || null, birthdate || null, phone || null, whatsapp || null,
        email || null, emergency_contact_name || null, emergency_contact_number || null,
        device_name || null, headset || null, internet_connection || null, backup_available || null,
        JSON.stringify(backup_types || []), status || 'active', req.params.id
      ]
    });
    await logActivity('team_member', name.trim(), 'updated', `Team member "${name.trim()}" edited`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireSuperAdmin, async (req, res) => {
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

router.post('/:id/photo', requireSuperAdmin, photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const path = `${req.params.id}.${extForMimetype(req.file.mimetype)}`;
    await uploadBase64(BUCKETS.teamPhotos, path, req.file.buffer.toString('base64'), req.file.mimetype);
    await getDb().execute({ sql: "UPDATE team_members SET photo_storage_path = ?, updated_at = now() WHERE id = ?", args: [path, req.params.id] });
    const signedUrl = await getSignedUrl(BUCKETS.teamPhotos, path);
    res.json({ success: true, photo: signedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
