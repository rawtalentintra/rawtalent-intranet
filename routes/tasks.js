const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');
const { matchPersonOrCentre } = require('../services/taskPersonMatchService');
const { BUCKETS, ensureBucket, uploadBuffer, downloadAsBuffer, remove: removeFile, extForMimetype, setFileResponseHeaders } = require('../services/storageService');

// Same limit as announcements/projects — any file type, not just images.
const taskFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Every signed-in user, any role — this is the whole point of the feature
// (see public/index.html's Tasks tab). No role gate at all.
router.use(requireAuth);

// 'requested_bookings' is Bookings-department-only (2026-08-24) — a
// booking request that's come in and needs actioning, shown as its own
// column ahead of To Do on the board. Kept in the same global STATUSES
// list (not a separate per-department enum) since every other piece of
// this feature — the modal, the board, notifications — already assumes
// one flat status set; validateStatusForDepartment() below is what
// actually restricts it to Bookings, not the list itself.
const STATUSES = ['requested_bookings', 'to_do', 'in_progress', 'in_review', 'done'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function validateStatusForDepartment(status, departmentId) {
  if (status === 'requested_bookings' && departmentId !== 'bookings') {
    return '"Requested Bookings" is only a valid status for the Bookings department';
  }
  return null;
}

// Finds @Name mentions in a note body against the known active-user list and
// returns the matched emails. Matches on full display name (case-insensitive,
// longest names first so "Joy Smith" doesn't get eaten by a bare "@Joy"
// match first) — simple substring match, no fancy tokenizing, since the
// frontend's autocomplete is what actually inserts these mentions.
function extractMentions(body, users) {
  if (!body) return [];
  // Single combined regex, longest name first — NOT independent
  // per-user substring checks. Independent checks would say "John" is
  // mentioned whenever "John Smith" is (if both are real users), since
  // "@John" is a literal substring of "@John Smith" followed by a
  // non-letter (a space). Ordering the alternatives longest-first makes
  // the regex engine consume "John Smith" whole before "John" ever gets
  // a chance to match inside it.
  const candidates = users
    .map(u => ({ email: u.email.toLowerCase(), label: (u.name || u.email.split('@')[0]).trim() }))
    .filter(c => c.label)
    .sort((a, b) => b.label.length - a.label.length);
  if (!candidates.length) return [];
  const pattern = candidates.map(c => c.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('@(' + pattern + ')(?![A-Za-z])', 'gi');
  const found = new Set();
  let match;
  while ((match = re.exec(body)) !== null) {
    const owner = candidates.find(c => c.label.toLowerCase() === match[1].toLowerCase());
    if (owner) found.add(owner.email);
  }
  return [...found];
}

// Shared by task create/update — description mentions are recomputed on
// every save (unlike task_notes.mentioned_emails, which freezes at the
// moment a note is posted), since a description is a mutable field, not a
// running log.
async function resolveDescriptionMentions(db, description, excludeEmail) {
  const usersRes = await db.execute("SELECT email, name FROM users WHERE active = true");
  return extractMentions(description || '', usersRes.rows).filter(e => e.toLowerCase() !== excludeEmail.toLowerCase());
}

// Full dataset, client-side grouping/filtering — same convention as Leads/
// Reports/My Centres in this codebase, rather than server-side query params.
router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute(`
      SELECT t.*, tc.name AS classification_name
      FROM tasks t
      LEFT JOIN task_classifications tc ON tc.id = t.classification_id
      ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Departments, classifications, and the active-user list a task can be
// assigned to / a note can @mention — one call so the frontend can build
// every dropdown before the first render.
router.get('/meta', async (req, res) => {
  try {
    const db = getDb();
    const [depts, classifications, users] = await Promise.all([
      db.execute('SELECT * FROM task_departments ORDER BY sort_order ASC'),
      db.execute('SELECT * FROM task_classifications ORDER BY name ASC'),
      db.execute("SELECT email, name, role FROM users WHERE active = true ORDER BY name ASC NULLS LAST, email ASC")
    ]);
    res.json({ departments: depts.rows, classifications: classifications.rows, users: users.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live match-as-you-type against real RT candidates/clients from a task
// title (or any free text) — see taskPersonMatchService.js. Called on
// every debounced title keystroke from the frontend, before the task is
// even saved, so this deliberately has no side effects.
router.get('/match-person', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ phoneDigits: null, nameGuess: '', candidates: [], candidateDuplicates: false, clients: [], clientDuplicates: false });
  try {
    res.json(await matchPersonOrCentre(q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/classifications', async (req, res) => {
  const { department_id, name } = req.body;
  if (!department_id?.trim() || !name?.trim()) return res.status(400).json({ error: 'department_id and name are required' });
  try {
    const db = getDb();
    const dept = await db.execute({ sql: 'SELECT id FROM task_departments WHERE id = ?', args: [department_id] });
    if (!dept.rows[0]) return res.status(404).json({ error: 'Department not found' });

    // Reuse an existing classification with the same name in this
    // department rather than creating a visually-identical duplicate.
    const existing = await db.execute({
      sql: 'SELECT * FROM task_classifications WHERE department_id = ? AND LOWER(name) = LOWER(?)',
      args: [department_id, name.trim()]
    });
    if (existing.rows[0]) return res.json({ success: true, classification: existing.rows[0] });

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO task_classifications (id, department_id, name, created_by) VALUES (?, ?, ?, ?)',
      args: [id, department_id, name.trim(), req.user.email]
    });
    const row = await db.execute({ sql: 'SELECT * FROM task_classifications WHERE id = ?', args: [id] });
    res.json({ success: true, classification: row.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Normalises the incoming assignee list — dedupes case-insensitively and
// lowercases for consistent comparison everywhere else (notifications'
// taskAlerts query, the "assigned to me" filter). Silently drops anything
// that isn't a non-empty string rather than erroring, since this only
// ever comes from the assignee picker in practice, not hand-typed input.
function normalizeAssignees(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const email of list) {
    if (typeof email === 'string' && email.trim()) seen.add(email.trim().toLowerCase());
  }
  return [...seen];
}

// Same dedupe-and-drop-junk discipline as normalizeAssignees, keyed by
// userId (a candidate's RT id) instead of email. Silently drops anything
// malformed rather than erroring, since this only ever comes from the
// match-picker/add-another UI in practice, not hand-typed input.
function normalizeLinkedCandidates(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || c.userId == null) continue;
    if (seen.has(c.userId)) continue;
    seen.add(c.userId);
    out.push({ userId: c.userId, name: typeof c.name === 'string' ? c.name : null, phone: typeof c.phone === 'string' ? c.phone : null });
  }
  return out;
}

router.post('/', async (req, res) => {
  const {
    department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date,
    linked_candidates, linked_client_name, linked_client_phone
  } = req.body;
  if (!department_id?.trim()) return res.status(400).json({ error: 'Department is required' });
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  const deptStatusError = validateStatusForDepartment(status, department_id);
  if (deptStatusError) return res.status(400).json({ error: deptStatusError });
  try {
    const db = getDb();
    const id = uuidv4();
    const finalStatus = status || 'to_do';
    const mentioned = await resolveDescriptionMentions(db, description, req.user.email);
    await db.execute({
      sql: `INSERT INTO tasks
            (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, completed_at, mentioned_emails,
             linked_candidates, linked_client_name, linked_client_phone)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, department_id, classification_id || null, title.trim(), description || null,
        finalStatus, priority || 'normal', JSON.stringify(normalizeAssignees(assigned_to_emails)), due_date || null,
        req.user.email, req.user.name || req.user.email,
        finalStatus === 'done' ? new Date().toISOString() : null,
        JSON.stringify(mentioned),
        JSON.stringify(normalizeLinkedCandidates(linked_candidates)),
        linked_client_name || null, linked_client_phone || null
      ]
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const {
    department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date,
    linked_candidates, linked_client_name, linked_client_phone
  } = req.body;
  if (!department_id?.trim()) return res.status(400).json({ error: 'Department is required' });
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  const deptStatusError = validateStatusForDepartment(status, department_id);
  if (deptStatusError) return res.status(400).json({ error: deptStatusError });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT status, completed_at FROM tasks WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Task not found' });
    const finalStatus = status || existing.rows[0].status;
    // completed_at only gets set the moment status actually transitions
    // into 'done', and clears if it's reopened — not touched on every save.
    let completedAt = existing.rows[0].completed_at;
    if (finalStatus === 'done' && existing.rows[0].status !== 'done') completedAt = new Date().toISOString();
    else if (finalStatus !== 'done') completedAt = null;
    const mentioned = await resolveDescriptionMentions(db, description, req.user.email);

    await db.execute({
      sql: `UPDATE tasks SET
              department_id=?, classification_id=?, title=?, description=?, status=?, priority=?,
              assigned_to_emails=?, due_date=?, completed_at=?, mentioned_emails=?,
              linked_candidates=?, linked_client_name=?, linked_client_phone=?,
              updated_at=now()
            WHERE id=?`,
      args: [
        department_id, classification_id || null, title.trim(), description || null, finalStatus,
        priority || 'normal', JSON.stringify(normalizeAssignees(assigned_to_emails)), due_date || null, completedAt, JSON.stringify(mentioned),
        JSON.stringify(normalizeLinkedCandidates(linked_candidates)),
        linked_client_name || null, linked_client_phone || null,
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
    await db.execute({ sql: 'DELETE FROM task_notes WHERE task_id = ?', args: [req.params.id] });
    const result = await db.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [req.params.id] });
    if (!result.rowsAffected) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/notes', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC',
      args: [req.params.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/notes', async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Note text is required' });
  try {
    const db = getDb();
    const task = await db.execute({ sql: 'SELECT id, title FROM tasks WHERE id = ?', args: [req.params.id] });
    if (!task.rows[0]) return res.status(404).json({ error: 'Task not found' });

    const usersRes = await db.execute("SELECT email, name FROM users WHERE active = true");
    const mentioned = extractMentions(body, usersRes.rows).filter(e => e.toLowerCase() !== req.user.email.toLowerCase());

    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO task_notes (id, task_id, body, author_email, author_name, mentioned_emails)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, body.trim(), req.user.email, req.user.name || req.user.email, JSON.stringify(mentioned)]
    });
    const row = await db.execute({ sql: 'SELECT * FROM task_notes WHERE id = ?', args: [id] });
    res.json({ success: true, note: row.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Author, or admin/super_admin, may edit/delete — otherwise anyone could
// alter or remove someone else's note. Same shape as
// routes/outreachLists.js's delete-ownership check.
function canModifyNote(note, user) {
  return note.author_email.toLowerCase() === user.email.toLowerCase() || ['admin', 'super_admin'].includes(user.role);
}

router.put('/:id/notes/:noteId', async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Note text is required' });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT * FROM task_notes WHERE id = ? AND task_id = ?', args: [req.params.noteId, req.params.id] });
    const note = existing.rows[0];
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!canModifyNote(note, req.user)) return res.status(403).json({ error: 'Only the author or an admin can edit this note' });

    const usersRes = await db.execute("SELECT email, name FROM users WHERE active = true");
    const mentioned = extractMentions(body, usersRes.rows).filter(e => e.toLowerCase() !== note.author_email.toLowerCase());

    await db.execute({
      sql: `UPDATE task_notes SET body = ?, mentioned_emails = ?, edited_at = now(), edited_by = ?, edited_by_name = ? WHERE id = ?`,
      args: [body.trim(), JSON.stringify(mentioned), req.user.email, req.user.name || req.user.email, req.params.noteId]
    });
    const row = await db.execute({ sql: 'SELECT * FROM task_notes WHERE id = ?', args: [req.params.noteId] });
    res.json({ success: true, note: row.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/notes/:noteId', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT * FROM task_notes WHERE id = ? AND task_id = ?', args: [req.params.noteId, req.params.id] });
    const note = existing.rows[0];
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!canModifyNote(note, req.user)) return res.status(403).json({ error: 'Only the author or an admin can delete this note' });

    await db.execute({ sql: 'DELETE FROM task_notes WHERE id = ?', args: [req.params.noteId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All attachments for the task in one call (description's and every
// note's together) — the modal fetches once on open, same call-shape as
// GET /:id/notes, and the frontend buckets by note_id client-side.
router.get('/:id/attachments', async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC', args: [req.params.id] });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// body.noteId (optional, form field) — omitted/null attaches to the
// task's description, a real task_notes.id attaches to that note. Any
// file type (unlike Idea's images-only paste flow) — this is a plain
// multipart upload rather than idea-files' base64 path, since by the
// time this is ever called the task/note the file belongs to already
// exists as a real row (see public/index.html's staging design: nothing
// uploads until the task/note itself is actually saved).
router.post('/:id/attachments', taskFileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = getDb();
    const task = await db.execute({ sql: 'SELECT id FROM tasks WHERE id = ?', args: [req.params.id] });
    if (!task.rows[0]) return res.status(404).json({ error: 'Task not found' });
    const noteId = req.body.noteId || null;
    if (noteId) {
      const note = await db.execute({ sql: 'SELECT id FROM task_notes WHERE id = ? AND task_id = ?', args: [noteId, req.params.id] });
      if (!note.rows[0]) return res.status(404).json({ error: 'Note not found' });
    }

    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO task_attachments (id, task_id, note_id, filename, mimetype, filesize, uploaded_by, uploaded_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, noteId, req.file.originalname, req.file.mimetype, req.file.size, req.user.email, req.user.name || req.user.email]
    });
    const storagePath = `${req.params.id}/${id}.${extForMimetype(req.file.mimetype)}`;
    await ensureBucket(BUCKETS.taskFiles);
    await uploadBuffer(BUCKETS.taskFiles, storagePath, req.file.buffer, req.file.mimetype);
    await db.execute({ sql: 'UPDATE task_attachments SET storage_path = ? WHERE id = ?', args: [storagePath, id] });

    const row = await db.execute({ sql: 'SELECT * FROM task_attachments WHERE id = ?', args: [id] });
    res.json({ success: true, attachment: row.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Content-Disposition: inline (not attachment) — lets an <img>/<iframe>
// preview render the bytes directly, same as routes/notifications.js's
// announcement-file download; a real "Save As" still works via the
// browser's own inline-preview save option, or the preview modal's
// separate Download link.
router.get('/attachments/:attachmentId/download', async (req, res) => {
  try {
    const file = (await getDb().execute({ sql: 'SELECT * FROM task_attachments WHERE id = ?', args: [req.params.attachmentId] })).rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!file.storage_path) return res.status(404).json({ error: 'This attachment has no stored content' });
    const buffer = await downloadAsBuffer(BUCKETS.taskFiles, file.storage_path);
    setFileResponseHeaders(res, { mimetype: file.mimetype, filename: file.filename, wantInline: true });
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Uploader, or admin/super_admin, may delete — same shape as
// canModifyNote above.
function canModifyAttachment(attachment, user) {
  return attachment.uploaded_by.toLowerCase() === user.email.toLowerCase() || ['admin', 'super_admin'].includes(user.role);
}

router.delete('/attachments/:attachmentId', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT * FROM task_attachments WHERE id = ?', args: [req.params.attachmentId] });
    const attachment = existing.rows[0];
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    if (!canModifyAttachment(attachment, req.user)) return res.status(403).json({ error: 'Only the uploader or an admin can delete this attachment' });

    await db.execute({ sql: 'DELETE FROM task_attachments WHERE id = ?', args: [req.params.attachmentId] });
    if (attachment.storage_path) {
      try { await removeFile(BUCKETS.taskFiles, attachment.storage_path); } catch { /* orphaned storage object, non-fatal */ }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
