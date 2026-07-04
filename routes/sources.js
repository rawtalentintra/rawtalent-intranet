const express = require('express');
const router = express.Router();
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');
const { streamQuestion } = require('../services/aiService');
const { load: cheerioLoad } = require('cheerio');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Explicitly sync FTS index — Turso cloud doesn't fire SQLite triggers
async function upsertKsFts(id, title, content) {
  const db = getDb();
  try {
    await db.execute({ sql: 'DELETE FROM knowledge_sources_fts WHERE id = ?', args: [id] });
    await db.execute({ sql: 'INSERT INTO knowledge_sources_fts(id, title, content) VALUES (?, ?, ?)', args: [id, title, content] });
  } catch {}
}
async function deleteKsFts(id) {
  try { await getDb().execute({ sql: 'DELETE FROM knowledge_sources_fts WHERE id = ?', args: [id] }); } catch {}
}

// ── Ask AI — available to all authenticated users ─────────────────
router.post('/ask', requireAuth, async (req, res) => {
  const { question, history } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await streamQuestion(question.trim(), req.user.email, Array.isArray(history) ? history : [], res);
  } catch (err) {
    console.error('AI ask error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      try { res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`); res.end(); } catch {}
    }
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
    await upsertKsFts(id, title, text.trim());
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
    const db = getDb();
    const dup = await db.execute({ sql: 'SELECT id FROM knowledge_sources WHERE origin = ?', args: [url.trim()] });
    if (dup.rows.length) return res.status(409).json({ error: 'This URL is already in your knowledge base. Use Refresh to update its content.' });
    const { title, text } = await fetchWebText(url.trim());
    if (!text.trim()) return res.status(400).json({ error: 'No readable content found at that URL' });
    const id = uuidv4();
    const finalTitle = customTitle?.trim() || title;
    await db.execute({
      sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'website', finalTitle, url.trim(), text.trim(), req.user.email]
    });
    await upsertKsFts(id, finalTitle, text.trim());
    res.json({ success: true, id, title: finalTitle });
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
    await upsertKsFts(req.params.id, title, text.trim());
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
    await upsertKsFts(id, title.trim(), content.trim());
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
          const db = getDb();
          const dup = await db.execute({ sql: 'SELECT id FROM knowledge_sources WHERE origin = ?', args: [url] });
          if (dup.rows.length) { added.push({ url, title, skipped: true }); return; }
          const id = uuidv4();
          await db.execute({
            sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
            args: [id, 'website', title, url, text.trim(), req.user.email]
          });
          await upsertKsFts(id, title, text.trim());
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

// Refresh all website sources
router.post('/refresh-all', async (req, res) => {
  const db = getDb();
  const result = await db.execute('SELECT id, origin FROM knowledge_sources WHERE type = "website" AND origin != ""');
  const sources = result.rows;
  const refreshed = [], failed = [];
  const BATCH = 3;
  for (let i = 0; i < sources.length; i += BATCH) {
    await Promise.allSettled(sources.slice(i, i + BATCH).map(async (src) => {
      try {
        const { title, text } = await fetchWebText(src.origin);
        await db.execute({
          sql: "UPDATE knowledge_sources SET title=?, content=?, updated_at=datetime('now') WHERE id=?",
          args: [title, text.trim(), src.id]
        });
        await upsertKsFts(src.id, title, text.trim());
        refreshed.push(src.origin);
      } catch (e) { failed.push({ origin: src.origin, reason: e.message }); }
    }));
    if (i + BATCH < sources.length) await new Promise(r => setTimeout(r, 600));
  }
  res.json({ refreshed: refreshed.length, failed: failed.length, total: sources.length });
});

// Remove duplicate sources (same origin URL — keep newest)
router.post('/dedup', async (req, res) => {
  const db = getDb();
  const result = await db.execute(
    `SELECT origin, COUNT(*) as cnt, MIN(created_at) as oldest_created
     FROM knowledge_sources WHERE origin != '' GROUP BY origin HAVING cnt > 1`
  );
  let removed = 0;
  for (const row of result.rows) {
    const dupes = await db.execute({
      sql: 'SELECT id FROM knowledge_sources WHERE origin = ? ORDER BY created_at DESC',
      args: [row.origin]
    });
    // Keep the first (newest), delete the rest
    for (const dupe of dupes.rows.slice(1)) {
      await db.execute({ sql: 'DELETE FROM knowledge_sources WHERE id = ?', args: [dupe.id] });
      removed++;
    }
  }
  res.json({ removed, duplicateGroups: result.rows.length });
});

// Delete a source
router.delete('/:id', async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM knowledge_sources WHERE id = ?', args: [req.params.id] });
    await deleteKsFts(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sitemap discovery helper ──────────────────────────────────────
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function discoverSitemapUrls(origin, max) {
  const urls = new Set();

  function extractLocs(text) {
    // Try standard <loc> tags first
    const locs = [...text.matchAll(/<loc>\s*(https?:\/\/[^\s<>"]+?)\s*<\/loc>/gi)].map(m => m[1].trim());
    if (locs.length) return locs;
    // Fallback: any https URL in the text (Jina text output strips tags but keeps URLs)
    return [...text.matchAll(/https?:\/\/[^\s<>"']+/g)]
      .map(m => m[0].replace(/[.,;>)]+$/, ''))
      .filter(u => !u.match(/\.(jpg|jpeg|png|gif|svg|css|js|xml|pdf|zip|gz|ico|woff2?)(\?.*)?$/i));
  }

  async function fetchRaw(url) {
    // 1. Try direct with browser headers (fixes Railway plain-fetch blocking)
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/xml,application/xml,*/*' },
        signal: AbortSignal.timeout(10000)
      });
      if (r.ok) return await r.text();
    } catch {}
    // 2. Fallback: Jina Reader bypasses Cloudflare / WAF
    const jr = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '20' },
      signal: AbortSignal.timeout(25000)
    });
    if (!jr.ok) throw new Error(`Cannot fetch sitemap at ${url}`);
    return await jr.text();
  }

  async function parseSitemap(text) {
    if (urls.size >= max) return;
    const locs = extractLocs(text);
    // Sitemap index: entries point to other sitemaps
    const isIndex = text.includes('<sitemapindex') || locs.every(u => u.includes('sitemap'));
    if (isIndex && locs.length) {
      for (const sub of locs.slice(0, 5)) {
        if (urls.size >= max) break;
        try { await parseSitemap(await fetchRaw(sub)); } catch {}
      }
    } else {
      for (const u of locs) {
        if (urls.size >= max) break;
        urls.add(u);
      }
    }
  }

  // Priority order: robots.txt Sitemap directive, then common paths
  const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml'];
  try {
    const r = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const m = (await r.text()).match(/^Sitemap:\s*(.+)$/im);
      if (m) candidates.unshift(m[1].trim());
    }
  } catch {}

  for (const path of candidates) {
    if (urls.size > 0) break;
    try {
      const url = path.startsWith('http') ? path : `${origin}${path}`;
      await parseSitemap(await fetchRaw(url));
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
