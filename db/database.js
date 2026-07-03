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
  ];

  for (const sql of schema) {
    await db.execute(sql);
  }

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
  // Upgrade any legacy 'admin' accounts to 'super_admin' (safe — future admins are created as 'admin' via the UI)
  await db.execute("UPDATE users SET role = 'super_admin' WHERE role = 'admin'");

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
