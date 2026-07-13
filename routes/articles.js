const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');
const { BUCKETS, downloadAsBuffer } = require('../services/storageService');

// Search articles
router.get('/search', requireAuth, async (req, res) => {
  const { q, category, limit = 20 } = req.query;
  const db = getDb();

  try {
    let rows;
    if (q && q.trim().length > 0) {
      // websearch_to_tsquery tolerates arbitrary free-text user input (unlike
      // plainto_tsquery/to_tsquery, which can throw on certain syntax), so
      // there's no need for the LIKE-based fallback the old FTS5 MATCH query
      // used to need for malformed search terms.
      const result = await db.execute({
        sql: `SELECT id, title, summary, category, tags, created_at, updated_at
              FROM articles
              WHERE published = true
                AND search_vector @@ websearch_to_tsquery('english', ?)
                ${category ? 'AND category = ?' : ''}
              ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', ?)) DESC
              LIMIT ?`,
        args: [q.trim(), ...(category ? [category] : []), q.trim(), parseInt(limit)]
      });
      rows = result.rows;
    } else {
      const result = await db.execute({
        sql: `SELECT id, title, summary, category, tags, created_at, updated_at
              FROM articles
              WHERE published = true
                ${category ? 'AND category = ?' : ''}
              ORDER BY updated_at DESC
              LIMIT ?`,
        args: [...(category ? [category] : []), parseInt(limit)]
      });
      rows = result.rows;
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get categories
router.get('/categories', requireAuth, async (req, res) => {
  try {
    const result = await getDb().execute(
      `SELECT category, COUNT(*) as count FROM articles WHERE published = true AND category IS NOT NULL AND category != '' GROUP BY category ORDER BY count DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all glossary terms (for frontend highlighting)
router.get('/glossary', requireAuth, async (req, res) => {
  try {
    const result = await getDb().execute('SELECT term, definition FROM glossary ORDER BY LENGTH(term) DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve/download a file attachment — must be before /:id to avoid conflict
router.get('/file/:fileId', requireAuth, async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM article_files WHERE id = ?', args: [req.params.fileId] });
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!file.storage_path) return res.status(404).json({ error: 'This attachment has no stored content' });
    const buffer = await downloadAsBuffer(BUCKETS.articleFiles, file.storage_path);
    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Length', buffer.length);
    if (file.display_mode === 'download') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    }
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single article + auto-related
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute({
      sql: `SELECT a.*, u.name as author_name
            FROM articles a
            LEFT JOIN users u ON a.author_email = u.email
            WHERE a.id = ? AND a.published = true`,
      args: [req.params.id]
    });
    const article = result.rows[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const articleObj = { ...article, tags: article.tags || [] };
    articleObj.relatedArticles = await findRelatedArticles(db, articleObj);

    res.json(articleObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function findRelatedArticles(db, article) {
  const result = await db.execute({
    sql: 'SELECT id, title, summary, category, tags FROM articles WHERE published = true AND id != ?',
    args: [article.id]
  });

  if (result.rows.length === 0) return [];

  const currentTags = article.tags || [];
  const currentCategory = (article.category || '').toLowerCase();
  const currentWords = extractKeywords(article.title + ' ' + (article.summary || ''));

  const scored = result.rows.map(a => {
    const aTags = a.tags || [];
    const aCategory = (a.category || '').toLowerCase();
    const aWords = extractKeywords(a.title + ' ' + (a.summary || ''));

    let score = 0;
    if (currentCategory && aCategory === currentCategory) score += 4;

    const sharedTags = currentTags.filter(t =>
      aTags.map(x => x.toLowerCase()).includes(t.toLowerCase())
    );
    score += sharedTags.length * 3;

    const sharedWords = currentWords.filter(w => aWords.includes(w));
    score += sharedWords.length;

    return { ...a, score };
  });

  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ id, title, summary, category }) => ({ id, title, summary, category }));
}

// List file attachments for an article (metadata only)
router.get('/:id/files', requireAuth, async (req, res) => {
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

// Submit feedback on an article
router.post('/:id/feedback', requireAuth, async (req, res) => {
  const { suggestedChanges } = req.body;
  if (!suggestedChanges?.trim()) return res.status(400).json({ error: 'Suggested changes are required' });

  try {
    const db = getDb();
    const artRes = await db.execute({ sql: 'SELECT title FROM articles WHERE id = ? AND published = true', args: [req.params.id] });
    const article = artRes.rows[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });

    await db.execute({
      sql: 'INSERT INTO feedback (article_id, article_title, suggested_changes, submitted_by) VALUES (?, ?, ?, ?)',
      args: [req.params.id, article.title, suggestedChanges.trim(), req.user.email]
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function extractKeywords(text) {
  const stopWords = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'how','what','when','where','why','is','are','was','were','be','been',
    'has','have','had','do','does','did','will','would','could','should',
    'this','that','these','those','it','its','from','by','as','if','not'
  ]);
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
}

module.exports = router;
