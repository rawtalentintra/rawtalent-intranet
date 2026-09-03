const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { requireAdmin, requireSuperAdmin, requireRole } = require('../middleware/authMiddleware');
const { saveArticleToDrive, deleteArticleFromDrive, syncFromDrive } = require('../services/driveService');
const { logActivity } = require('../services/activityLog');
const { invalidateUserCache } = require('../config/passport');
const { BUCKETS, uploadBuffer, extForMimetype, remove: removeFile } = require('../services/storageService');

function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// pdf-parse (and to a lesser extent mammoth) can hang for a very long time
// on certain malformed/scanned PDFs instead of erroring — confirmed as the
// cause of "Parsing document…" spinning forever on a real SOP upload, with
// no timeout anywhere in the request to catch it. This doesn't cancel the
// underlying parse (neither library supports that), but it stops the
// request — and the user — from waiting indefinitely with no feedback.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `${label} took too long to parse. It may be a scanned/image-based file with no selectable text, or the file may be corrupted — try converting it to .docx or .txt first, or paste the content in manually.`
    )), ms))
  ]);
}

// ── Articles (view/add/edit + attachments) — admin, super_admin, and ──
// ── qa_view/workforce_partner, two narrow roles scoped to exactly this ──
// ── plus FAQ management and call quality. Registered ahead of the blanket ──
// ── requireAdmin below so they can reach these specific routes without ──
// ── gaining access to anything else in this router (users, glossary, ──
// ── feedback, logs, drive sync, etc). ──
const articleAccess = requireRole('admin', 'super_admin', 'qa_view', 'workforce_partner');

// ── Glossary (view/add/edit) — same qa_view/workforce_partner access as ──
// ── Articles, delete stays admin/super_admin only (registered further ──
// ── down, after the blanket requireAdmin). Plain users get read-only ──
// ── terms elsewhere via /api/articles/glossary. ──
const glossaryAccess = requireRole('admin', 'super_admin', 'qa_view', 'workforce_partner');

router.get('/glossary', glossaryAccess, async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM glossary ORDER BY term ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/glossary', glossaryAccess, async (req, res) => {
  const { term, definition } = req.body;
  if (!term || !definition) return res.status(400).json({ error: 'Term and definition are required' });
  try {
    await getDb().execute({ sql: 'INSERT INTO glossary (term, definition) VALUES (?, ?)', args: [term.trim(), definition.trim()] });
    await logActivity('glossary', term.trim(), 'created', `Term "${term.trim()}" added`, req.user.email);
    res.json({ success: true });
  } catch {
    res.status(409).json({ error: 'That term already exists' });
  }
});

router.put('/glossary/:id', glossaryAccess, async (req, res) => {
  const { term, definition } = req.body;
  if (!term || !definition) return res.status(400).json({ error: 'Term and definition are required' });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT id, term FROM glossary WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Term not found' });
    await db.execute({
      sql: "UPDATE glossary SET term=?, definition=?, updated_at=now() WHERE id=?",
      args: [term.trim(), definition.trim(), req.params.id]
    });
    await logActivity('glossary', term.trim(), 'updated', `Term "${existing.rows[0].term}" updated`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/articles', articleAccess, async (req, res) => {
  try {
    const result = await getDb().execute(
      'SELECT id, title, summary, category, tags, published, created_at, updated_at, author_email FROM articles ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/articles/:id', articleAccess, async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM articles WHERE id = ?', args: [req.params.id] });
    const article = result.rows[0];
    if (!article) return res.status(404).json({ error: 'Not found' });
    res.json(article);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/articles', articleAccess, async (req, res) => {
  try {
    const { title, summary, content, category, tags, relatedIds, published = true } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

    const id = uuidv4();
    const now = new Date().toISOString();
    const db = getDb();

    const driveFileId = await saveArticleToDrive({
      id, title, summary, content, category,
      tags: tags || [], relatedArticleIds: relatedIds || [],
      author: req.user.email, published,
      createdAt: now, updatedAt: now
    });

    await db.execute({
      sql: `INSERT INTO articles (id, title, summary, content, category, tags, related_ids, author_email, published, drive_file_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, title, summary || '', content, category || '', JSON.stringify(tags || []),
        JSON.stringify(relatedIds || []), req.user.email, !!published, driveFileId, now, now]
    });

    await db.execute({
      sql: 'INSERT INTO article_logs (article_id, article_title, action, changes_summary, changed_by) VALUES (?, ?, ?, ?, ?)',
      args: [id, title, 'created', 'Article created', req.user.email]
    });

    res.json({ success: true, id });
  } catch (err) {
    console.error('Create article error:', err);
    res.status(500).json({ error: err.message || 'Failed to save article' });
  }
});

router.put('/articles/:id', articleAccess, async (req, res) => {
  try {
    const { title, summary, content, category, tags, relatedIds, published } = req.body;
    const db = getDb();
    const existRes = await db.execute({ sql: 'SELECT * FROM articles WHERE id = ?', args: [req.params.id] });
    const existing = existRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'Article not found' });

    const changes = [];
    if (title !== existing.title) changes.push(`Title: "${existing.title}" → "${title}"`);
    if ((summary || '') !== (existing.summary || '')) changes.push('Summary updated');
    if (content !== existing.content) changes.push('Content updated');
    if ((category || '') !== (existing.category || '')) changes.push(`Category: "${existing.category || 'none'}" → "${category || 'none'}"`);
    if (JSON.stringify(tags || []) !== JSON.stringify(existing.tags || [])) changes.push('Tags updated');
    if (Boolean(published) !== Boolean(existing.published)) changes.push(`Status: ${existing.published ? 'Published' : 'Draft'} → ${published ? 'Published' : 'Draft'}`);

    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE articles SET title=?, summary=?, content=?, category=?, tags=?, related_ids=?, published=?, updated_at=? WHERE id=?`,
      args: [title, summary || '', content, category || '', JSON.stringify(tags || []),
        JSON.stringify(relatedIds || []), !!published, now, req.params.id]
    });

    await db.execute({
      sql: 'INSERT INTO article_logs (article_id, article_title, action, changes_summary, changed_by) VALUES (?, ?, ?, ?, ?)',
      args: [req.params.id, title, 'updated', changes.length ? changes.join(' | ') : 'Minor edits', req.user.email]
    });

    await saveArticleToDrive({
      id: req.params.id, title, summary, content, category,
      tags: tags || [], relatedArticleIds: relatedIds || [],
      author: existing.author_email, published,
      createdAt: existing.created_at, updatedAt: now,
      drive_file_id: existing.drive_file_id
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update article error:', err);
    res.status(500).json({ error: err.message || 'Failed to update article' });
  }
});

// Generates a plain-English summary of what changed between two versions of
// an article, for the "Announce Changes" flow — the admin previews/edits it
// before it's actually posted as a real Announcement, so this endpoint just
// returns a draft rather than writing anything itself. Deliberately called
// on-demand (after a save, only if the admin clicks Announce Changes) rather
// than generated automatically inside PUT /articles/:id above, so routine
// saves that nobody intends to announce don't all pay for an AI call.
router.post('/articles/:id/summarize-changes', articleAccess, async (req, res) => {
  const { oldTitle, oldContent, newTitle, newContent } = req.body;
  if (!newContent) return res.status(400).json({ error: 'newContent is required' });
  const client = getAnthropicClient();
  if (!client) return res.status(500).json({ error: 'AI is not configured — set ANTHROPIC_API_KEY.' });
  try {
    // Same HTML-stripping approach already used elsewhere (aiService.js,
    // callGradingService.js) to turn Jodit's rich-text HTML into plain text
    // before it goes into a prompt.
    const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const oldText = strip(oldContent).slice(0, 6000);
    const newText = strip(newContent).slice(0, 6000);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      system: `You write short, plain-English change summaries for RawTalent's internal knowledge base, so staff can see what's new in an article without re-reading the whole thing. One to three sentences, factual and specific — name the actual thing that changed (a step added, a number or date updated, a broken link fixed, a new section) rather than vague language like "content was updated". Write in Australian English (e.g. "organise", "recognise", "centre"). If the title changed, mention that too. Respond with ONLY the summary text, nothing else.`,
      messages: [{
        role: 'user',
        content: `Article title: ${newTitle || oldTitle}${oldTitle && oldTitle !== newTitle ? ` (previously titled: ${oldTitle})` : ''}\n\nPREVIOUS VERSION:\n${oldText || '(no previous content on file)'}\n\nNEW VERSION:\n${newText}\n\nSummarise what changed, for a staff announcement.`
      }]
    });
    const textBlock = response.content.find(b => b.type === 'text');
    const summary = textBlock?.text?.trim();
    if (!summary) return res.status(500).json({ error: 'Could not generate a summary — please try again or write one manually.' });
    res.json({ summary });
  } catch (err) {
    console.error('Summarize article changes error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate summary' });
  }
});

router.post('/articles/:id/files', articleAccess, fileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { displayMode = 'download' } = req.body;
  try {
    const db = getDb();
    const artRes = await db.execute({ sql: 'SELECT id FROM articles WHERE id = ?', args: [req.params.id] });
    if (!artRes.rows[0]) return res.status(404).json({ error: 'Article not found' });

    const result = await db.execute({
      sql: 'INSERT INTO article_files (article_id, filename, mimetype, filesize, display_mode) VALUES (?, ?, ?, ?, ?) RETURNING id',
      args: [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, displayMode]
    });
    const fileId = result.rows[0].id;
    const storagePath = `${fileId}.${extForMimetype(req.file.mimetype)}`;
    await uploadBuffer(BUCKETS.articleFiles, storagePath, req.file.buffer, req.file.mimetype);
    await db.execute({ sql: 'UPDATE article_files SET storage_path = ? WHERE id = ?', args: [storagePath, fileId] });

    res.json({ success: true, id: fileId, filename: req.file.originalname, displayMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/articles/:id/files', articleAccess, async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT id, filename, mimetype, filesize, display_mode, created_at FROM article_files WHERE article_id = ? ORDER BY created_at ASC',
      args: [req.params.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(requireAdmin);

// ── Stats ─────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();
    const [total, draft, users, cats] = await Promise.all([
      db.execute('SELECT COUNT(*) as n FROM articles WHERE published=true'),
      db.execute('SELECT COUNT(*) as n FROM articles WHERE published=false'),
      db.execute('SELECT COUNT(*) as n FROM users WHERE active=true'),
      db.execute("SELECT COUNT(DISTINCT category) as n FROM articles WHERE published=true AND category!=''"),
    ]);
    res.json({
      totalArticles: Number(total.rows[0].n),
      draftArticles: Number(draft.rows[0].n),
      totalUsers: Number(users.rows[0].n),
      categories: Number(cats.rows[0].n)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Users (super_admin only) ──────────────────────────────────────
router.get('/users', requireSuperAdmin, async (req, res) => {
  try {
    const result = await getDb().execute(
      'SELECT id, email, name, role, active, can_build_training, can_create_outreach_lists, wfp_label, created_at, last_login FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', requireSuperAdmin, async (req, res) => {
  const { email, name, password, role = 'user', active = true, canBuildTraining = false, canCreateOutreachLists = false, wfpLabel } = req.body;
  if (!email || !name) return res.status(400).json({ error: 'Email and name are required' });
  if (!email.toLowerCase().endsWith('@rawtalent.com.au')) {
    return res.status(400).json({ error: 'Only @rawtalent.com.au email addresses are allowed' });
  }

  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email.toLowerCase()] });
    if (existing.rows[0]) return res.status(409).json({ error: 'A user with this email already exists' });

    const hash = password ? await bcrypt.hash(password, 12) : null;
    await db.execute({
      sql: 'INSERT INTO users (email, name, password_hash, role, active, can_build_training, can_create_outreach_lists, wfp_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [email.toLowerCase(), name, hash, role, !!active, !!canBuildTraining, !!canCreateOutreachLists, wfpLabel || null]
    });
    await logActivity('user', email.toLowerCase(), 'created', `User "${name}" (${role}) created`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', requireSuperAdmin, async (req, res) => {
  const { name, role, active, password, canBuildTraining, canCreateOutreachLists, wfpLabel } = req.body;
  try {
    const db = getDb();
    const targetRes = await db.execute({ sql: 'SELECT email, name, role, active, can_build_training, can_create_outreach_lists, wfp_label FROM users WHERE id = ?', args: [req.params.id] });
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });

    const adminEmail = (process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au').toLowerCase();
    if (target.email.toLowerCase() === adminEmail && role && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot change the primary admin role' });
    }

    const changes = [];
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, req.params.id] });
      changes.push('Password reset');
    }
    if (name !== undefined && name !== target.name) { await db.execute({ sql: 'UPDATE users SET name = ? WHERE id = ?', args: [name, req.params.id] }); changes.push(`Name: "${target.name}" → "${name}"`); }
    if (role !== undefined && role !== target.role) { await db.execute({ sql: 'UPDATE users SET role = ? WHERE id = ?', args: [role, req.params.id] }); changes.push(`Role: "${target.role}" → "${role}"`); }
    if (active !== undefined && Boolean(active) !== Boolean(target.active)) { await db.execute({ sql: 'UPDATE users SET active = ? WHERE id = ?', args: [!!active, req.params.id] }); changes.push(active ? 'Account activated' : 'Account deactivated'); }
    if (canBuildTraining !== undefined && Boolean(canBuildTraining) !== Boolean(target.can_build_training)) { await db.execute({ sql: 'UPDATE users SET can_build_training = ? WHERE id = ?', args: [!!canBuildTraining, req.params.id] }); changes.push(canBuildTraining ? 'Granted Build Training access' : 'Revoked Build Training access'); }
    if (canCreateOutreachLists !== undefined && Boolean(canCreateOutreachLists) !== Boolean(target.can_create_outreach_lists)) { await db.execute({ sql: 'UPDATE users SET can_create_outreach_lists = ? WHERE id = ?', args: [!!canCreateOutreachLists, req.params.id] }); changes.push(canCreateOutreachLists ? 'Granted Outreach List access' : 'Revoked Outreach List access'); }
    // Ties a workforce_partner login to their existing leads.assigned_
    // workforce_partner/centre_partner_assignments label (see db/schema.sql's
    // own comment on this column) — was DB-only until now (2026-09-03, the
    // /wfp mobile app's territory scoping), set directly via Supabase/SQL.
    // Free text, not validated against WORKFORCE_PARTNER_OPTIONS here —
    // matching convention is on the person setting it, same as every other
    // place this string gets typed in this app.
    if (wfpLabel !== undefined && (wfpLabel || null) !== (target.wfp_label || null)) { await db.execute({ sql: 'UPDATE users SET wfp_label = ? WHERE id = ?', args: [wfpLabel || null, req.params.id] }); changes.push(`Workforce Partner label: "${target.wfp_label || '—'}" → "${wfpLabel || '—'}"`); }

    invalidateUserCache(Number(req.params.id));
    await logActivity('user', target.email, 'updated', changes.length ? changes.join(' | ') : 'Minor edits', req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', requireSuperAdmin, async (req, res) => {
  try {
    const db = getDb();
    const targetRes = await db.execute({ sql: 'SELECT email FROM users WHERE id = ?', args: [req.params.id] });
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.email.toLowerCase() === (process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au').toLowerCase()) {
      return res.status(400).json({ error: 'Cannot delete the primary admin account' });
    }
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [req.params.id] });
    invalidateUserCache(Number(req.params.id));
    await logActivity('user', target.email, 'deleted', `User "${target.email}" removed`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Active Sessions & Impersonation (super_admin only) ─────────────
// Reads straight from the Turso-backed session store — a session counts as
// "active" if it hasn't expired and carries a real logged-in (passport) user.
router.get('/active-sessions', requireSuperAdmin, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute('SELECT sess, expires FROM sessions');
    const now = Date.now();
    const sessionCounts = new Map(); // userId (string) -> count

    for (const row of result.rows) {
      if (row.expires && Number(row.expires) < now) continue;
      let parsed;
      try { parsed = JSON.parse(row.sess); } catch { continue; }
      const uid = parsed?.passport?.user;
      if (uid == null) continue;
      const key = String(uid);
      sessionCounts.set(key, (sessionCounts.get(key) || 0) + 1);
    }

    if (sessionCounts.size === 0) return res.json([]);

    const ids = [...sessionCounts.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const usersRes = await db.execute({
      sql: `SELECT id, email, name, role FROM users WHERE id IN (${placeholders})`,
      args: ids
    });

    res.json(usersRes.rows.map(u => ({ ...u, sessionCount: sessionCounts.get(String(u.id)) || 1 })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/impersonate/:id', requireSuperAdmin, async (req, res) => {
  if (req.session.impersonatorId) {
    return res.status(400).json({ error: 'Already logged in as another user — return to your account first.' });
  }
  try {
    const db = getDb();
    const targetRes = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.params.id] });
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!target.active) return res.status(400).json({ error: 'Cannot log in as a disabled account' });
    if (target.id === req.user.id) return res.status(400).json({ error: "That's your own account" });

    const originalId = req.user.id;
    const originalEmail = req.user.email;

    req.login(target, (err) => {
      if (err) return res.status(500).json({ error: 'Failed to switch account' });
      req.session.impersonatorId = originalId;
      req.session.save(async (saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Failed to switch account' });
        await logActivity('session', target.email, 'impersonation-start', `${originalEmail} logged in as ${target.email}`, originalEmail);
        res.json({ success: true, user: { email: target.email, name: target.name, role: target.role } });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Articles ──────────────────────────────────────────────────────
// GET/POST/PUT and file attachments are registered near the top of this
// file (ahead of the blanket requireAdmin) so qa_view can reach them —
// only delete stays here, admin/super_admin only.
router.delete('/articles/:id', async (req, res) => {
  try {
    const db = getDb();
    const artRes = await db.execute({ sql: 'SELECT drive_file_id FROM articles WHERE id = ?', args: [req.params.id] });
    if (!artRes.rows[0]) return res.status(404).json({ error: 'Article not found' });
    await deleteArticleFromDrive(artRes.rows[0].drive_file_id);
    await db.execute({ sql: 'DELETE FROM articles WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    await syncFromDrive();
    res.json({ success: true, message: 'Sync from Google Drive complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/drive-status', async (req, res) => {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!key || !folderId) {
    return res.json({ connected: false, reason: 'Environment variables not set' });
  }
  try {
    const credentials = JSON.parse(Buffer.from(key, 'base64').toString());
    const serviceAccountEmail = credentials.client_email || 'unknown';
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: 1
    });
    res.json({ connected: true, serviceAccountEmail, fileCount: result.data.files.length });
  } catch (err) {
    let credentials = {};
    try { credentials = JSON.parse(Buffer.from(key, 'base64').toString()); } catch {}
    res.json({ connected: false, serviceAccountEmail: credentials.client_email, reason: err.message });
  }
});

// Glossary delete stays admin/super_admin only (qa_view gets view/add/edit
// above, near the top of this file, ahead of the blanket requireAdmin —
// same view/add/edit-no-delete split as Articles). Plain users get
// read-only glossary terms via /api/articles/glossary.
router.delete('/glossary/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT term FROM glossary WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM glossary WHERE id = ?', args: [req.params.id] });
    if (existing.rows[0]) await logActivity('glossary', existing.rows[0].term, 'deleted', `Term "${existing.rows[0].term}" removed`, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Feedback (admin and super_admin — router-level requireAdmin above covers this) ──
router.get('/feedback', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM feedback ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/feedback/:id', async (req, res) => {
  const { status, adminComments } = req.body;
  try {
    await getDb().execute({
      sql: "UPDATE feedback SET status=?, admin_comments=?, updated_at=now() WHERE id=?",
      args: [status || 'pending', adminComments ?? '', req.params.id]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/feedback/:id', async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM feedback WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Article Logs (super_admin only) ──────────────────────────────
router.get('/article-logs', requireSuperAdmin, async (req, res) => {
  try {
    const { articleId } = req.query;
    const result = articleId
      ? await getDb().execute({ sql: 'SELECT * FROM article_logs WHERE article_id = ? ORDER BY created_at DESC', args: [articleId] })
      : await getDb().execute('SELECT * FROM article_logs ORDER BY created_at DESC LIMIT 200');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/article-logs/:id', requireSuperAdmin, async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM article_logs WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── System Logs — user & glossary activity (super_admin only) ────
router.get('/system-logs', requireSuperAdmin, async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 200');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/system-logs/:id', requireSuperAdmin, async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM system_logs WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Document Import ───────────────────────────────────────────────
router.post('/parse-document', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const baseName = path.basename(req.file.originalname, ext)
    .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

  try {
    let html = '';
    let title = baseName;

    if (ext === '.pdf') {
      const data = await withTimeout(pdfParse(req.file.buffer), 45000, 'PDF parsing');
      const text = data.text;
      const lines = text.split(/\r?\n/);

      const firstNonEmpty = lines.findIndex(l => l.trim());
      if (firstNonEmpty >= 0) title = lines[firstNonEmpty].trim();

      const body = lines.slice(firstNonEmpty + 1);
      let paragraph = [];
      const paragraphs = [];
      for (const line of body) {
        if (line.trim()) {
          paragraph.push(line.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
        } else if (paragraph.length) {
          paragraphs.push(`<p>${paragraph.join(' ')}</p>`);
          paragraph = [];
        }
      }
      if (paragraph.length) paragraphs.push(`<p>${paragraph.join(' ')}</p>`);
      html = paragraphs.join('\n');

    } else if (ext === '.docx') {
      const result = await withTimeout(mammoth.convertToHtml(
        { buffer: req.file.buffer },
        {
          styleMap: [
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Title'] => h1:fresh",
            "b => strong",
            "i => em"
          ]
        }
      ), 45000, 'DOCX parsing');
      html = result.value;

      const headingMatch = html.match(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/i);
      if (headingMatch) {
        const headingText = headingMatch[1].replace(/<[^>]+>/g, '').trim();
        if (headingText) {
          title = headingText;
          html = html.slice(html.indexOf(headingMatch[0]) + headingMatch[0].length).trim();
        }
      }

      html = html.replace(/^(<p>\s*<\/p>\s*)+/, '').trim();

    } else if (ext === '.txt') {
      const text = req.file.buffer.toString('utf8');
      const lines = text.split(/\r?\n/);

      const firstNonEmpty = lines.findIndex(l => l.trim());
      if (firstNonEmpty >= 0) title = lines[firstNonEmpty].trim();

      const body = lines.slice(firstNonEmpty + 1);
      let paragraph = [];
      const paragraphs = [];
      for (const line of body) {
        if (line.trim()) {
          paragraph.push(line.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
        } else if (paragraph.length) {
          paragraphs.push(`<p>${paragraph.join(' ')}</p>`);
          paragraph = [];
        }
      }
      if (paragraph.length) paragraphs.push(`<p>${paragraph.join(' ')}</p>`);
      html = paragraphs.join('\n');

    } else {
      return res.status(400).json({ error: 'Unsupported file type. Please upload a .pdf, .docx, or .txt file.' });
    }

    const summaryMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const summary = summaryMatch
      ? summaryMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 280)
      : '';

    res.json({ title, content: html, summary, warnings: [] });
  } catch (err) {
    console.error('Document parse error:', err);
    res.status(500).json({ error: 'Failed to parse document: ' + err.message });
  }
});

// ── Article File Attachments ──────────────────────────────────────
// POST/GET are registered near the top of this file (ahead of the blanket
// requireAdmin) so qa_view can reach them — delete stays admin/super_admin.
router.delete('/files/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT storage_path FROM article_files WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM article_files WHERE id = ?', args: [req.params.id] });
    if (existing.rows[0]?.storage_path) {
      try { await removeFile(BUCKETS.articleFiles, existing.rows[0].storage_path); } catch { /* orphaned storage object, non-fatal */ }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
