-- Postgres schema for the RawTalent Knowledge Base, migrated from Turso/SQLite.
-- Run once against a fresh Supabase project (Phase 1 of the Turso -> Supabase
-- migration). Existing data is imported separately in Phase 2; blob columns
-- (photo/file/audio data) are intentionally NOT included here — those move to
-- Supabase Storage in Phase 4, replaced by a `*_storage_path` reference.
--
-- Translated from db/database.js's SQLite schema:
--   INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
--   TEXT PRIMARY KEY (app-generated UUIDs) -> unchanged
--   datetime('now') defaults          -> now()
--   INTEGER 0/1 booleans              -> BOOLEAN
--   JSON-in-TEXT columns              -> JSONB
--   FTS5 virtual tables + triggers    -> generated tsvector columns + GIN indexes
--
-- No new foreign-key constraints are added here on purpose — this migration
-- preserves current (lack of) referential integrity to minimize risk; FKs can
-- be layered in later once the CRM data model work begins.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT,
  role TEXT DEFAULT 'user',
  google_id TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  category TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  related_ids JSONB DEFAULT '[]'::jsonb,
  author_email TEXT,
  published BOOLEAN DEFAULT true,
  drive_file_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'D')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_articles_search ON articles USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS glossary (
  id SERIAL PRIMARY KEY,
  term TEXT UNIQUE NOT NULL,
  definition TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  article_id TEXT NOT NULL,
  article_title TEXT NOT NULL,
  suggested_changes TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  admin_comments TEXT DEFAULT '',
  submitted_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS article_logs (
  id SERIAL PRIMARY KEY,
  article_id TEXT NOT NULL,
  article_title TEXT NOT NULL,
  action TEXT NOT NULL,
  changes_summary TEXT DEFAULT '',
  changed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- `data` (base64 blob) is replaced by `storage_path` — populated in Phase 4
-- when existing file attachments are uploaded to the `article-files` bucket.
CREATE TABLE IF NOT EXISTS article_files (
  id SERIAL PRIMARY KEY,
  article_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  filesize INTEGER,
  storage_path TEXT,
  display_mode TEXT DEFAULT 'download',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT,
  content TEXT NOT NULL,
  added_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_search ON knowledge_sources USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS ai_query_log (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT,
  sources_used JSONB DEFAULT '[]'::jsonb,
  asked_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_logs (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_label TEXT NOT NULL,
  action TEXT NOT NULL,
  changes_summary TEXT DEFAULT '',
  changed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Slack and Fathom conversations are never used as AI sources directly. Every
-- scanned conversation lands here — including ones Claude auto-rejected — so a
-- super_admin has full visibility into what was looked at. Only a 'pending' row
-- that a super_admin explicitly approves becomes a real, visible FAQ.
-- suggested_question/suggested_answer are null when Claude auto-rejects.
CREATE TABLE IF NOT EXISTS faq_candidates (
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
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faqs (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source TEXT,
  source_date TEXT,
  approved_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(question, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(answer, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_faqs_search ON faqs USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS slack_scan_state (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT,
  last_ts TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Singleton row (id = 1), upserted via ON CONFLICT — not a SERIAL, the app
-- always addresses it by a fixed id.
CREATE TABLE IF NOT EXISTS fathom_scan_state (
  id INTEGER PRIMARY KEY,
  last_synced_at TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- One row per AI-graded call, feeding the future Call Quality Reporting dashboard.
-- category_scores is a JSON array of {category, weight, score, notes}.
CREATE TABLE IF NOT EXISTS call_evaluations (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  rep_name TEXT,
  call_type TEXT,
  rubric_type TEXT NOT NULL,
  call_date TEXT,
  duration_seconds INTEGER,
  category_scores JSONB NOT NULL,
  overall_score REAL NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT,
  evaluated_by TEXT,
  source TEXT DEFAULT 'ai',
  reviewer_feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Standing calibration notes from a reviewer, persisted so every future AI
-- grading call applies the same corrections — not just the one call the
-- feedback was given on.
CREATE TABLE IF NOT EXISTS call_grading_calibration (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-category overrides on top of the built-in rubric: "description" is the
-- short bullet-point summary shown in the reference table (a JSON array of
-- strings), kept in sync automatically by AI whenever "instructions" (longer,
-- admin-authored grading guidance fed straight into the AI's system prompt)
-- changes.
CREATE TABLE IF NOT EXISTS call_rubric_customizations (
  id TEXT PRIMARY KEY,
  rubric_type TEXT NOT NULL,
  category_key TEXT NOT NULL,
  description JSONB,
  instructions TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(rubric_type, category_key)
);

-- Local cache of Dubber recording metadata, fetched eagerly at sync time
-- along with the transcript — so browsing never has to hit Dubber's
-- rate-limited API, and a call is ready to evaluate the moment it's synced.
-- has_audio is a fast flag for list display; the audio itself lives in
-- call_recording_audio (kept separate so listing/filtering never has to
-- touch large blobs), mirroring how article attachments are stored.
-- start_time/start_time_iso stay TEXT (not timestamptz) since they're
-- passed through verbatim from Dubber's API and aren't guaranteed to be a
-- format Postgres can parse without risk of import failures.
CREATE TABLE IF NOT EXISTS call_recordings (
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
  has_audio BOOLEAN DEFAULT false,
  content_synced BOOLEAN DEFAULT false,
  meta_tags JSONB,
  synced_at TIMESTAMPTZ DEFAULT now()
);

-- `data` (base64 audio blob) is replaced by `storage_path` — populated in
-- Phase 4 when existing call audio is uploaded to the `call-recordings` bucket.
CREATE TABLE IF NOT EXISTS call_recording_audio (
  recording_id TEXT PRIMARY KEY,
  storage_path TEXT,
  mimetype TEXT DEFAULT 'audio/mpeg',
  filesize INTEGER,
  fetched_at TIMESTAMPTZ DEFAULT now()
);

-- Singleton row (id = 1), upserted via ON CONFLICT.
CREATE TABLE IF NOT EXISTS dubber_sync_state (
  id INTEGER PRIMARY KEY,
  last_synced_at TEXT,
  total_synced INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Express session store, backed by the same Supabase Postgres DB as
-- everything else — logins survive redeploys instead of resetting every
-- time the container restarts (the default in-memory session store).
-- expires is epoch milliseconds — must be BIGINT, not INTEGER (32-bit
-- INTEGER overflows for a millisecond timestamp).
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

-- "Our Team" HR directory — org chart (via manager_id) plus a personal
-- profile per person. Contains real PII (address, birthdate, home setup),
-- so this whole feature is super_admin only, same gate as Users.
-- `photo` (base64) is replaced by `photo_storage_path` — populated in
-- Phase 4 when existing photos are uploaded to the `team-photos` bucket.
CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  position TEXT,
  team TEXT,
  manager_id TEXT,
  sort_order INTEGER DEFAULT 0,
  photo_storage_path TEXT,
  employment_date TEXT,
  address TEXT,
  birthdate TEXT,
  phone TEXT,
  whatsapp TEXT,
  email TEXT,
  emergency_contact_name TEXT,
  emergency_contact_number TEXT,
  device_name TEXT,
  headset TEXT,
  internet_connection TEXT,
  backup_available TEXT,
  backup_types JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Every one of these backs a WHERE/ORDER BY that route handlers run on every
-- request (call browsing/filtering, article listing, team lookups, session/
-- login checks) — without an index each is a full table scan that gets
-- slower as the table grows.
CREATE INDEX IF NOT EXISTS idx_call_recordings_start_time ON call_recordings(start_time_iso);
CREATE INDEX IF NOT EXISTS idx_call_recordings_rep_name ON call_recordings(rep_name);
CREATE INDEX IF NOT EXISTS idx_call_evaluations_created_at ON call_evaluations(created_at);
CREATE INDEX IF NOT EXISTS idx_call_evaluations_recording_id ON call_evaluations(recording_id);
CREATE INDEX IF NOT EXISTS idx_team_members_manager_id ON team_members(manager_id);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_feedback_article_id ON feedback(article_id);
CREATE INDEX IF NOT EXISTS idx_article_logs_article_id ON article_logs(article_id);
