const express = require('express');
const router = express.Router();
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');
const { askQuestion } = require('../services/aiService');
const { load: cheerioLoad } = require('cheerio');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Ask AI — available to all authenticated users ─────────────────
router.post('/ask', requireAuth, async (req, res) => {
  const { question, history } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });
  try {
    const result = await askQuestion(question.trim(), req.user.email, Array.isArray(history) ? history : []);
    res.json(result);
  } catch (err) {
    console.error('AI ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Everything below is super_admin only ─────────────────────────
router.use(requireSuperAdmin);

// List all sources
router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute(
      'SELECT id, type, title, origin, added_by, created_at, updated_at FROM knowledge_sources ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload a document (PDF, DOCX, TXT)
router.post('/document', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    let text = '';
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else if (ext === '.pdf') {
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else if (ext === '.txt') {
      text = req.file.buffer.toString('utf8');
    } else {
      return res.status(400).json({ error: 'Supported types: .pdf, .docx, .txt' });
    }

    if (!text.trim()) return res.status(400).json({ error: 'No text could be extracted from this file' });

    const id = uuidv4();
    const title = req.body.title?.trim() || path.basename(req.file.originalname, ext);
    await getDb().execute({
      sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'document', title, req.file.originalname, text.trim(), req.user.email]
    });
    res.json({ success: true, id, title });
  } catch (err) {
    console.error('Document ingest error:', err.message);
    res.status(500).json({ error: 'Failed to process document: ' + err.message });
  }
});

// Add a website URL
router.post('/website', async (req, res) => {
  const { url, title: customTitle } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'URL is required' });
  try {
    const { title, text } = await fetchWebText(url.trim());
    if (!text.trim()) return res.status(400).json({ error: 'No readable content found at that URL' });
    const id = uuidv4();
    await getDb().execute({
      sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'website', customTitle?.trim() || title, url.trim(), text.trim(), req.user.email]
    });
    res.json({ success: true, id, title: customTitle?.trim() || title });
  } catch (err) {
    console.error('Website ingest error:', err.message);
    res.status(500).json({ error: 'Failed to fetch website: ' + err.message });
  }
});

// Refresh a website source (re-fetch its content)
router.post('/:id/refresh', async (req, res) => {
  const db = getDb();
  const result = await db.execute({ sql: 'SELECT origin FROM knowledge_sources WHERE id = ? AND type = "website"', args: [req.params.id] });
  const src = result.rows[0];
  if (!src) return res.status(404).json({ error: 'Website source not found' });
  try {
    const { title, text } = await fetchWebText(src.origin);
    await db.execute({
      sql: "UPDATE knowledge_sources SET title=?, content=?, updated_at=datetime('now') WHERE id=?",
      args: [title, text.trim(), req.params.id]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refresh: ' + err.message });
  }
});

// Paste content manually (for sites that block scraping)
router.post('/paste', async (req, res) => {
  const { title, content, origin } = req.body;
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Title and content are required' });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'website', title.trim(), origin?.trim() || '', content.trim(), req.user.email]
    });
    res.json({ success: true, id, title: title.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crawl an entire website via its sitemap
router.post('/crawl', async (req, res) => {
  const { url: baseUrl, maxPages = 25 } = req.body;
  if (!baseUrl?.trim()) return res.status(400).json({ error: 'URL is required' });
  let origin;
  try { origin = new URL(baseUrl.trim()).origin; }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const urls = await discoverSitemapUrls(origin, Math.min(Number(maxPages) || 25, 50));
    if (!urls.length) {
      return res.status(404).json({ error: `No sitemap found at ${origin}. Try adding pages individually or using the Paste option.` });
    }

    const added = [], failed = [];
    const BATCH = 5;
    for (let i = 0; i < urls.length; i += BATCH) {
      await Promise.allSettled(urls.slice(i, i + BATCH).map(async (url) => {
        try {
          const { title, text } = await fetchWebText(url);
          if (!text.trim()) { failed.push({ url, reason: 'No content extracted' }); return; }
          const id = uuidv4();
          await getDb().execute({
            sql: 'INSERT OR IGNORE INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
            args: [id, 'website', title, url, text.trim(), req.user.email]
          });
          added.push({ url, title });
        } catch (e) { failed.push({ url, reason: e.message }); }
      }));
      if (i + BATCH < urls.length) await new Promise(r => setTimeout(r, 400));
    }
    res.json({ added, failed, discovered: urls.length });
  } catch (err) {
    console.error('Crawl error:', err.message);
    res.status(500).json({ error: 'Crawl failed: ' + err.message });
  }
});

// Delete a source
router.delete('/:id', async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM knowledge_sources WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sitemap discovery helper ──────────────────────────────────────
async function discoverSitemapUrls(origin, max) {
  const urls = new Set();

  async function parseSitemap(xml) {
    if (urls.size >= max) return;
    if (xml.includes('<sitemapindex')) {
      // Sitemap index — recurse into sub-sitemaps
      const subs = [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gs)].map(m => m[1].trim());
      for (const sub of subs.slice(0, 5)) {
        if (urls.size >= max) break;
        try {
          const r = await fetch(sub, { signal: AbortSignal.timeout(8000) });
          if (r.ok) await parseSitemap(await r.text());
        } catch {}
      }
    } else {
      const locs = [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gs)].map(m => m[1].trim());
      for (const u of locs) {
        if (urls.size >= max) break;
        if (!u.match(/\.(jpg|jpeg|png|gif|svg|css|js|xml|pdf|zip|gz)(\?.*)?$/i)) urls.add(u);
      }
    }
  }

  // Check robots.txt first — many sites list their sitemap there
  const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml'];
  try {
    const r = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const txt = await r.text();
      const m = txt.match(/^Sitemap:\s*(.+)$/im);
      if (m) candidates.unshift(m[1].trim());
    }
  } catch {}

  for (const path of candidates) {
    if (urls.size > 0) break;
    try {
      const url = path.startsWith('http') ? path : `${origin}${path}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) await parseSitemap(await r.text());
    } catch {}
  }

  return [...urls].slice(0, max);
}

// ── Web fetch helper — uses Jina Reader to bypass bot protection ──
async function fetchWebText(url) {
  // Jina Reader renders the full page (including JS) and bypasses most bot protection
  const jinaUrl = `https://r.jina.ai/${url}`;
  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'text',
      'X-Timeout': '25'
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Could not retrieve content from ${url} (status ${response.status})`);
  const raw = await response.text();

  // Jina returns lines like "Title: ..." and "URL Source: ..." at the top
  const titleMatch = raw.match(/^Title:\s*(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Strip the metadata header lines, keep the actual content
  const contentStart = raw.indexOf('\n\n');
  const text = (contentStart > -1 ? raw.slice(contentStart) : raw).trim();

  return { title, text };
}

module.exports = router;
