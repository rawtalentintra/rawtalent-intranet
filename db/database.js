const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

let client;

function getDb() {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL || 'file:./knowledgebase.db',
      authToken: process.env.TURSO_AUTH_TOKEN
    });
  }
  return client;
}

const ECEC_GLOSSARY = [
  { term: 'ASQA', definition: 'Australian Skills Quality Authority — the national regulator for vocational education and training (VET) in Australia.' },
  { term: 'WWCC', definition: 'Working With Children Check — mandatory government clearance required for anyone working with children in Australia.' },
  { term: 'DNU', definition: 'Do Not Use — an internal status flag marking an educator as ineligible for placement.' },
  { term: 'ECEC', definition: 'Early Childhood Education and Care — the regulated sector covering childcare centres and preschools.' },
  { term: 'RTO', definition: 'Registered Training Organisation — a government-accredited provider of vocational education and training qualifications.' },
  { term: 'SPES', definition: 'SPES Education — a former RTO whose qualifications have been cancelled by ASQA.' },
  { term: 'RFC', definition: 'Reason for Calling — the purpose/reason field logged when making a call note.' },
  { term: 'ROTC', definition: 'Result of the Call — the outcome field logged after completing a call.' },
  { term: 'EOD', definition: 'End of Day — used in handover notes and shift summaries.' },
  { term: 'CXL', definition: 'Cancellation — shorthand used internally for a cancelled booking or shift.' },
  { term: 'Fill Rate', definition: 'The percentage of requested shifts that were successfully staffed with an educator.' },
  { term: 'Room Leader', definition: 'The senior qualified educator responsible for a specific room within a childcare centre.' },
  { term: 'Induction', definition: 'A mandatory orientation conducted by the childcare centre before an educator begins their first shift there.' },
  { term: 'Account Freeze', definition: 'A temporary restriction placed on an educator\'s account, preventing new bookings until resolved.' },
  { term: 'Red Zone', definition: 'An account restriction status indicating serious non-compliance — one step below DNU.' },
  { term: 'Workforce Registry', definition: 'A government registry for tracking qualified Early Childhood Education and Care educators.' },
  { term: 'Handover', definition: 'Shift-to-shift notes passed between the morning and afternoon teams to ensure continuity.' },
  { term: 'Admin Portal', definition: 'The internal platform used by the RawTalent team for managing bookings, timesheets, and educator profiles.' },
  { term: 'Booking ID', definition: 'A unique identifier assigned to each shift booking record in the Admin Portal.' },
  { term: 'Candidate ID', definition: 'A unique identifier for each educator profile used when searching or assigning in the system.' },
  { term: 'Unfilled Booking', definition: 'A shift request from a centre that has not yet been assigned an educator.' },
  { term: 'No-Show', definition: 'When an educator fails to attend a confirmed shift without prior notice.' },
  { term: 'VIC', definition: 'Victoria — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'SA', definition: 'South Australia — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'QLD', definition: 'Queensland — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'ACT', definition: 'Australian Capital Territory — one of the regions where RawTalent operates educator placements.' },
  { term: 'Cert III', definition: 'Certificate III in Early Childhood Education and Care — the minimum qualification required for most casual educator roles.' },
  { term: 'Diploma', definition: 'Diploma of Early Childhood Education and Care — a higher qualification required for Room Leader and senior roles.' },
  { term: 'NQF', definition: 'National Quality Framework — the regulatory framework governing the quality of early childhood education and care services in Australia.' },
  { term: 'NQS', definition: 'National Quality Standard — the benchmark for quality in early childhood education and care services under the NQF.' },
  { term: 'ACECQA', definition: 'Australian Children\'s Education and Care Quality Authority — the national body overseeing the NQF and quality standards.' },
  { term: 'Centre', definition: 'A childcare service or client site where RawTalent places casual educators.' },
  { term: 'Educator', definition: 'A casual worker placed by RawTalent into childcare centres — must hold appropriate qualifications and clearances.' },
  { term: 'Booking', definition: 'A confirmed shift placement — the core transaction matching an educator to a centre for a specific date and time.' },
];

async function initDatabase() {
  const db = getDb();

  const schema = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT,
      name TEXT,
      role TEXT DEFAULT 'user',
      google_id TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      content TEXT,
      category TEXT,
      tags TEXT DEFAULT '[]',
      related_ids TEXT DEFAULT '[]',
      author_email TEXT,
      published INTEGER DEFAULT 1,
      drive_file_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS glossary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT UNIQUE NOT NULL,
      definition TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      id UNINDEXED,
      title,
      summary,
      content,
      category,
      tags,
      content=articles,
      content_rowid=rowid
    )`,
    `CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, id, title, summary, content, category, tags)
      VALUES (new.rowid, new.id, new.title, new.summary, new.content, new.category, new.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, id, title, summary, content, category, tags)
      VALUES('delete', old.rowid, old.id, old.title, old.summary, old.content, old.category, old.tags);
      INSERT INTO articles_fts(rowid, id, title, summary, content, category, tags)
      VALUES (new.rowid, new.id, new.title, new.summary, new.content, new.category, new.tags);
    END`,
    `CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, id, title, summary, content, category, tags)
      VALUES('delete', old.rowid, old.id, old.title, old.summary, old.content, old.category, old.tags);
    END`,
    `CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id TEXT NOT NULL,
      article_title TEXT NOT NULL,
      suggested_changes TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      admin_comments TEXT DEFAULT '',
      submitted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS article_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id TEXT NOT NULL,
      article_title TEXT NOT NULL,
      action TEXT NOT NULL,
      changes_summary TEXT DEFAULT '',
      changed_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS article_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      filesize INTEGER,
      data TEXT NOT NULL,
      display_mode TEXT DEFAULT 'download',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      origin TEXT,
      content TEXT NOT NULL,
      added_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_sources_fts USING fts5(
      id UNINDEXED, title, content,
      content=knowledge_sources, content_rowid=rowid
    )`,
    `CREATE TRIGGER IF NOT EXISTS ks_ai AFTER INSERT ON knowledge_sources BEGIN
      INSERT INTO knowledge_sources_fts(rowid, id, title, content)
      VALUES (new.rowid, new.id, new.title, new.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS ks_au AFTER UPDATE ON knowledge_sources BEGIN
      INSERT INTO knowledge_sources_fts(knowledge_sources_fts, rowid, id, title, content)
      VALUES('delete', old.rowid, old.id, old.title, old.content);
      INSERT INTO knowledge_sources_fts(rowid, id, title, content)
      VALUES (new.rowid, new.id, new.title, new.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS ks_ad AFTER DELETE ON knowledge_sources BEGIN
      INSERT INTO knowledge_sources_fts(knowledge_sources_fts, rowid, id, title, content)
      VALUES('delete', old.rowid, old.id, old.title, old.content);
    END`,
    `CREATE TABLE IF NOT EXISTS ai_query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT,
      sources_used TEXT DEFAULT '[]',
      asked_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_label TEXT NOT NULL,
      action TEXT NOT NULL,
      changes_summary TEXT DEFAULT '',
      changed_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    // Slack and Fathom conversations are never used as AI sources directly. Every
    // scanned conversation lands here — including ones Claude auto-rejected — so a
    // super_admin has full visibility into what was looked at. Only a 'pending' row
    // that a super_admin explicitly approves becomes a real, visible FAQ.
    // suggested_question/suggested_answer are null when Claude auto-rejects.
    `CREATE TABLE IF NOT EXISTS faq_candidates (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_channel TEXT,
      source_ref TEXT,
      source_date TEXT,
      raw_excerpt TEXT,
      suggested_question TEXT,
      suggested_answer TEXT,
      classification_reason TEXT,
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS faqs (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source TEXT,
      source_date TEXT,
      approved_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS faqs_fts USING fts5(id UNINDEXED, question, answer)`,
    `CREATE TABLE IF NOT EXISTS slack_scan_state (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT,
      last_ts TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS fathom_scan_state (
      id INTEGER PRIMARY KEY,
      last_synced_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    // One row per AI-graded call, feeding the future Call Quality Reporting dashboard.
    // category_scores is a JSON array of {category, weight, score, notes}.
    `CREATE TABLE IF NOT EXISTS call_evaluations (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL,
      rep_name TEXT,
      call_type TEXT,
      rubric_type TEXT NOT NULL,
      call_date TEXT,
      duration_seconds INTEGER,
      category_scores TEXT NOT NULL,
      overall_score REAL NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT,
      evaluated_by TEXT,
      source TEXT DEFAULT 'ai',
      reviewer_feedback TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    // Standing calibration notes from a reviewer, persisted so every future AI
    // grading call applies the same corrections — not just the one call the
    // feedback was given on.
    `CREATE TABLE IF NOT EXISTS call_grading_calibration (
      id TEXT PRIMARY KEY,
      note TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    // Per-category overrides on top of the built-in rubric: "description" is
    // the short bullet-point summary shown in the reference table, kept in
    // sync automatically by AI whenever "instructions" (longer, admin-authored
    // grading guidance fed straight into the AI's system prompt) changes.
    `CREATE TABLE IF NOT EXISTS call_rubric_customizations (
      id TEXT PRIMARY KEY,
      rubric_type TEXT NOT NULL,
      category_key TEXT NOT NULL,
      description TEXT,
      instructions TEXT,
      updated_by TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(rubric_type, category_key)
    )`,
    // Local cache of Dubber recording metadata, fetched eagerly at sync time
    // along with the transcript — so browsing never has to hit Dubber's
    // rate-limited API, and a call is ready to evaluate the moment it's synced.
    // has_audio is a fast flag for list display; the audio bytes themselves live
    // in call_recording_audio (kept separate so listing/filtering never has to
    // scan large blobs), mirroring how article attachments are stored.
    `CREATE TABLE IF NOT EXISTS call_recordings (
      id TEXT PRIMARY KEY,
      to_number TEXT,
      from_number TEXT,
      to_label TEXT,
      from_label TEXT,
      rep_name TEXT,
      call_type TEXT,
      duration_seconds INTEGER,
      start_time TEXT,
      start_time_iso TEXT,
      status TEXT,
      sentiment_score REAL,
      transcript TEXT,
      has_audio INTEGER DEFAULT 0,
      content_synced INTEGER DEFAULT 0,
      meta_tags TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS call_recording_audio (
      recording_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      mimetype TEXT DEFAULT 'audio/mpeg',
      filesize INTEGER,
      fetched_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS dubber_sync_state (
      id INTEGER PRIMARY KEY,
      last_synced_at TEXT,
      total_synced INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const sql of schema) {
    await db.execute(sql);
  }

  // call_recordings shipped before has_audio/content_synced existed — add them
  // to any table created by an earlier deploy. "Duplicate column" errors are
  // expected (and ignored) on a fresh table where CREATE TABLE already has them.
  for (const col of ['has_audio INTEGER DEFAULT 0', 'content_synced INTEGER DEFAULT 0']) {
    try { await db.execute(`ALTER TABLE call_recordings ADD COLUMN ${col}`); } catch {}
  }

  // call_evaluations shipped before source (ai vs human grading) existed.
  try { await db.execute(`ALTER TABLE call_evaluations ADD COLUMN source TEXT DEFAULT 'ai'`); } catch {}
  try { await db.execute(`ALTER TABLE call_evaluations ADD COLUMN reviewer_feedback TEXT`); } catch {}

  // Turso cloud does not fire SQLite triggers, so the FTS index for knowledge_sources
  // never gets populated via the trigger-based approach. Fix: drop the content-table FTS,
  // recreate it as a standalone table, and populate it directly on every startup.
  await db.execute('DROP TRIGGER IF EXISTS ks_ai');
  await db.execute('DROP TRIGGER IF EXISTS ks_au');
  await db.execute('DROP TRIGGER IF EXISTS ks_ad');
  await db.execute('DROP TABLE IF EXISTS knowledge_sources_fts');
  await db.execute('CREATE VIRTUAL TABLE knowledge_sources_fts USING fts5(id UNINDEXED, title, content)');
  const ksSources = await db.execute('SELECT id, title, content FROM knowledge_sources');
  if (ksSources.rows.length > 0) {
    await db.batch(
      ksSources.rows.map(r => ({
        sql: 'INSERT INTO knowledge_sources_fts(id, title, content) VALUES (?, ?, ?)',
        args: [r.id, r.title, r.content]
      })),
      'write'
    );
  }
  console.log(`✓ knowledge_sources_fts rebuilt (${ksSources.rows.length} entries)`);

  const countRes = await db.execute('SELECT COUNT(*) as n FROM glossary');
  if (Number(countRes.rows[0].n) === 0) {
    await db.batch(
      ECEC_GLOSSARY.map(({ term, definition }) => ({
        sql: 'INSERT OR IGNORE INTO glossary (term, definition) VALUES (?, ?)',
        args: [term, definition]
      })),
      'write'
    );
    console.log(`✓ Glossary seeded with ${ECEC_GLOSSARY.length} ECEC terms`);
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au';
  const adminPassword = process.env.ADMIN_PASSWORD || 'RawTalent2024!';

  const existRes = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [adminEmail] });
  if (!existRes.rows[0]) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await db.execute({
      sql: `INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, 'Joy — Administrator', 'super_admin')`,
      args: [adminEmail, hash]
    });
    console.log(`✓ Super admin account created: ${adminEmail}`);
  }

  console.log('✓ Database ready');
}

module.exports = { getDb, initDatabase };
