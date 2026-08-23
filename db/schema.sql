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
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
-- Per-user grant, not a role — Build Training needs to be handed to one
-- specific person (e.g. Sophia) without opening it to every admin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_build_training BOOLEAN DEFAULT false;
-- Same pattern, for the Educator Outreach list builder (Decision Area 1,
-- 2026-08-22) — named ops staff (Adzi/Laurie/Vicky) build outreach lists
-- without being promoted off qa_view. admin/super_admin always have access
-- regardless of this flag (see requireOutreachListBuilder).
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_create_outreach_lists BOOLEAN DEFAULT false;
-- Ties a workforce_partner login to their existing free-text
-- leads.assigned_workforce_partner label (e.g. 'Gwen Stocks (SA)') so My
-- Centres/My Dashboard can default to that person's own portfolio. Not a
-- foreign key — assigned_workforce_partner has always been a plain label,
-- not a users.id reference, and changing that now would touch every
-- existing leads row; matching on the label string is the smaller change.
ALTER TABLE users ADD COLUMN IF NOT EXISTS wfp_label TEXT;

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
  reviewer_feedback_category TEXT,
  reviewer_feedback_categories JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);
ALTER TABLE call_evaluations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE call_evaluations ADD COLUMN IF NOT EXISTS reviewer_feedback_categories JSONB;

-- Every piece of feedback ever given on an evaluation via "Give Feedback &
-- Re-grade" — an append-only conversation thread. Re-grading updates the
-- evaluation's scores/notes in place (never inserts a new call_evaluations
-- row), but every round of feedback is preserved here so a reviewer can see
-- the full back-and-forth, no matter how many times a call was re-graded.
-- category_keys holds every category a single round of feedback targeted
-- (a reviewer can tag more than one at once); empty/null means general.
CREATE TABLE IF NOT EXISTS call_evaluation_feedback (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
  category_key TEXT,
  category_keys JSONB,
  feedback_text TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE call_evaluation_feedback ADD COLUMN IF NOT EXISTS category_keys JSONB;
CREATE INDEX IF NOT EXISTS idx_call_evaluation_feedback_eval_id ON call_evaluation_feedback(evaluation_id);
ALTER TABLE call_evaluations ADD COLUMN IF NOT EXISTS reviewer_feedback_category TEXT;

-- Standing calibration notes from a reviewer, persisted so every future AI
-- grading call applies the same corrections — not just the one call the
-- feedback was given on. rubric_type/category_key are nullable: a note tied
-- to a specific category (e.g. "opening" on the educator rubric) is only
-- injected into that category's grading instructions; a note with a
-- rubric_type but no category applies to every category of that rubric;
-- a note with neither is a fully general standing rule (the original
-- behaviour, kept for backwards compatibility with existing notes).
CREATE TABLE IF NOT EXISTS call_grading_calibration (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  rubric_type TEXT,
  category_key TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE call_grading_calibration ADD COLUMN IF NOT EXISTS rubric_type TEXT;
ALTER TABLE call_grading_calibration ADD COLUMN IF NOT EXISTS category_key TEXT;

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
  synced_at TIMESTAMPTZ DEFAULT now(),
  detected_rubric_type TEXT,
  detected_rubric_reasoning TEXT
);
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS detected_rubric_type TEXT;
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS detected_rubric_reasoning TEXT;
-- Dubber's AI-info endpoint (the same one that supplies the transcript) also
-- returns a genuine audio-derived emotion breakdown when the account's AI
-- config has it enabled — document_emotion is call-level (7 dimensions:
-- analytical/anger/confident/fear/joy/sadness/tentative), sentence_emotion is
-- per-sentence (same dimensions + that sentence's own sentiment score), so
-- the grader can point to specific moments rather than one aggregate number.
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS document_emotion JSONB;
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS sentence_emotion JSONB;

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
-- Freely-draggable position on the Our Team org canvas. NULL until someone
-- drags a box for the first time, at which point it locks that person's
-- position in place instead of following the auto-arranged grid default.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS chart_x DOUBLE PRECISION;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS chart_y DOUBLE PRECISION;
-- Manual override for where the horizontal segment of this person's
-- hierarchy-line elbow (from their manager down to them) sits, in org
-- canvas Y coordinates. NULL until dragged, at which point it overrides
-- the auto-computed midpoint bend — lets a crowded chart be untangled by
-- hand instead of relying purely on the automatic layout.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS chart_line_bend_y DOUBLE PRECISION;

-- Fun team-culture feature: birthday/work-anniversary greetings between
-- logged-in users. Upcoming-date reminders themselves are computed live from
-- team_members.birthdate/employment_date (not stored) — this table only
-- holds the greetings people actually send each other, so the recipient's
-- notification bell has something to show ("Shienna sent you a Birthday
-- Greeting!"). team_member_id is matched to a logged-in user by email at
-- read time, not a hard foreign key (not every team member has a login).
CREATE TABLE IF NOT EXISTS team_greetings (
  id TEXT PRIMARY KEY,
  team_member_id TEXT NOT NULL,
  greeting_type TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_by_email TEXT,
  sent_by_name TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_team_greetings_team_member_id ON team_greetings(team_member_id);

-- Admin-authored broadcast announcements — visible to every signed-in user
-- via the same notification bell as birthday/anniversary greetings.
-- send_at lets an admin schedule one for a future moment; a row simply
-- doesn't show up (and isn't counted unread) until send_at has passed —
-- no background job needed, the 5-minute notification poll picks it up.
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_email TEXT,
  created_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_send_at ON announcements(send_at);

CREATE TABLE IF NOT EXISTS announcement_files (
  id SERIAL PRIMARY KEY,
  announcement_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  filesize INTEGER,
  storage_path TEXT,
  display_mode TEXT DEFAULT 'download',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-user read state — every signed-in user (not just team_members rows)
-- can read an announcement, so this keys on email rather than a FK.
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  read_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (announcement_id, user_email)
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
CREATE INDEX IF NOT EXISTS idx_articles_published_category ON articles(published, category);
CREATE INDEX IF NOT EXISTS idx_article_files_article_id ON article_files(article_id);
CREATE INDEX IF NOT EXISTS idx_announcement_files_announcement_id ON announcement_files(announcement_id);

-- Single-row token store for the Webex Service App (Workforce Management).
-- Access tokens last 14 days and refresh tokens rotate (a new one is issued)
-- on every refresh, so both must be persisted here rather than left as a
-- static env var — WEBEX_REFRESH_TOKEN in .env only seeds this table once,
-- on first boot.
CREATE TABLE IF NOT EXISTS webex_auth_state (
  id INTEGER PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at BIGINT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- How long each agent has held their current Webex status — Webex's API has
-- no such field, so this is derived from our own poll history and must be
-- persisted (not kept in memory) so a deploy/restart doesn't reset every
-- agent's duration back to zero.
CREATE TABLE IF NOT EXISTS webex_agent_status_state (
  email CITEXT PRIMARY KEY,
  status TEXT NOT NULL,
  since BIGINT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Training Hub (LMS) ──────────────────────────────────────────────
-- A course is generated from source material (pasted or uploaded), broken
-- into modules with a short comprehension check after each one, plus a
-- final graded assessment. super_admin only for now — access is gated at
-- the route level, not the schema.
CREATE TABLE IF NOT EXISTS training_courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'live'
  source_material TEXT,
  pass_threshold INTEGER NOT NULL DEFAULT 80, -- % correct on the final assessment required to pass
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_modules (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_training_modules_course_id ON training_modules(course_id);

-- module_id is NULL for final-assessment questions, set for a per-module
-- comprehension check. question_type is fixed to 'multiple_choice' for now
-- (options/correct_answer only make sense for that) — a future
-- 'short_answer'/AI-graded type can reuse this table without a schema change.
CREATE TABLE IF NOT EXISTS training_questions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  module_id TEXT,
  question_type TEXT NOT NULL DEFAULT 'multiple_choice',
  question_text TEXT NOT NULL,
  options JSONB,
  correct_answer TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_training_questions_course_id ON training_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_training_questions_module_id ON training_questions(module_id);

CREATE TABLE IF NOT EXISTS training_attempts (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'completed'
  current_module_index INTEGER NOT NULL DEFAULT 0,
  module_results JSONB DEFAULT '[]',
  final_score REAL,
  final_passed BOOLEAN,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_training_attempts_course_id ON training_attempts(course_id);
CREATE INDEX IF NOT EXISTS idx_training_attempts_user_email ON training_attempts(user_email);

CREATE TABLE IF NOT EXISTS training_answers (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  selected_answer TEXT,
  is_correct BOOLEAN,
  answered_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_training_answers_attempt_id ON training_answers(attempt_id);

-- Pushing a course to specific people. One row per (course, person) — a
-- re-assignment (e.g. changing the due date) upserts rather than
-- duplicating. Shows up on that person's Training Dashboard and as a
-- pending item in their notification bell until their attempt is completed.
CREATE TABLE IF NOT EXISTS training_assignments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  due_date DATE,
  assigned_by_email TEXT,
  assigned_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(course_id, user_email)
);
CREATE INDEX IF NOT EXISTS idx_training_assignments_user_email ON training_assignments(user_email);

-- Internal projects (Client Relationship Management, Educator Engagement,
-- etc.) — a lightweight status/owner/timeline/SOP tracker for admins, not a
-- full task-management tool. name is UNIQUE so the starter set below can be
-- seeded idempotently.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT DEFAULT '🚀',
  color TEXT DEFAULT '#3d6fff',
  description TEXT,
  status TEXT NOT NULL DEFAULT 'on_track', -- 'planning' | 'on_track' | 'at_risk' | 'off_track' | 'on_hold' | 'completed'
  owner_name TEXT,
  owner_email TEXT,
  start_date DATE,
  target_date DATE,
  success_criteria TEXT,
  sop_content TEXT DEFAULT '',
  created_by_email TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Manual override for the Projects dashboard's priority badge/sort, which
-- otherwise computes purely from target_date (soonest deadline = most
-- urgent). NULL = auto; 'top'/'high'/'normal'/'low' pins the badge (and
-- sort position) regardless of what the deadline alone would suggest —
-- e.g. a project with no near-term deadline that still needs to jump the
-- queue, or a soon-due one that's actually fine to leave be.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS priority_override TEXT;

CREATE TABLE IF NOT EXISTS project_files (
  id SERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  filesize INTEGER,
  storage_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);

-- ON CONFLICT targets id (the real primary key), not name — name is
-- user-editable in the app, so a seed row whose name has since been changed
-- must still be recognized as "already seeded" by id, not re-inserted.
INSERT INTO projects (id, name, icon, color, description, status)
VALUES
  ('proj-crm', 'Client Relationship Management', '🤝', '#3d6fff', 'Managing and growing relationships with client centres.', 'on_track'),
  ('proj-educator-engagement', 'Educator Engagement', '🎓', '#22c55e', 'Keeping educators supported, informed, and engaged.', 'on_track'),
  ('proj-call-quality', 'Quality Call Evaluation', '📞', '#f59e0b', 'Grading and improving the quality of recruitment/sales calls.', 'on_track'),
  ('proj-document-checker', 'Document Checker', '📋', '#7c3aed', 'Verifying compliance documents (WWCC, certificates, etc.) are valid and current.', 'on_track')
ON CONFLICT (id) DO NOTHING;

-- Full Fathom meeting transcripts, persisted so the team (and AI analysis of
-- meeting content, e.g. SOP generation from Liam's instructions) never needs
-- to re-hit the Fathom API for meetings already seen. Distinct from
-- faq_candidates (which only keeps a 4000-char excerpt per meeting for FAQ
-- detection) — this keeps the FULL transcript with per-line speaker
-- attribution, since that's what's needed to reliably attribute who said
-- what. recording_id is Fathom's own id, used as the natural key.
CREATE TABLE IF NOT EXISTS fathom_meetings (
  recording_id BIGINT PRIMARY KEY,
  title TEXT,
  meeting_url TEXT,
  share_url TEXT,
  fathom_created_at TIMESTAMPTZ,
  recording_start_time TIMESTAMPTZ,
  recording_end_time TIMESTAMPTZ,
  transcript JSONB,          -- full array of {speaker:{display_name,...}, text, timestamp}
  transcript_text TEXT,      -- flattened "Speaker: line" text, computed at sync time — feeds search_vector and is what gets fed to Claude for Q&A
  speakers TEXT[],           -- denormalized distinct speaker display names, for fast filtering
  calendar_invitees JSONB,
  default_summary TEXT,
  action_items JSONB,
  highlights JSONB,
  synced_at TIMESTAMPTZ DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(transcript_text, '')), 'B')
  ) STORED
);
-- transcript_text/search_vector were added after fathom_meetings already
-- shipped, so existing databases need these as explicit ALTERs (a bare
-- CREATE TABLE IF NOT EXISTS above is a no-op once the table exists).
ALTER TABLE fathom_meetings ADD COLUMN IF NOT EXISTS transcript_text TEXT;
ALTER TABLE fathom_meetings ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(transcript_text, '')), 'B')
) STORED;

CREATE INDEX IF NOT EXISTS idx_fathom_meetings_start_time ON fathom_meetings(recording_start_time);
CREATE INDEX IF NOT EXISTS idx_fathom_meetings_speakers ON fathom_meetings USING GIN(speakers);
CREATE INDEX IF NOT EXISTS idx_fathom_meetings_search ON fathom_meetings USING GIN(search_vector);

-- Tracks how far the full-transcript sync has progressed, same pattern as
-- fathom_scan_state (which drives the separate FAQ-candidate scan) — kept
-- separate so the two sync jobs can run independently.
CREATE TABLE IF NOT EXISTS fathom_transcript_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Milestones within a project's overall timeline — the "where are we right
-- now" view the Projects table shows, distinct from the project's own
-- start/target date range (the outer bar). Display order is manual
-- (order_index, drag-to-reorder in the UI) rather than derived from
-- start_date, since milestones don't always have dates yet and the team
-- may want to sequence them before dates are confirmed; "which milestone
-- are we currently at" is still computed from actual dates at render time.
CREATE TABLE IF NOT EXISTS project_milestones (
  id SERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_milestones_project_id ON project_milestones(project_id);

-- order_index was added after project_milestones already shipped.
ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;

-- "Mark all read" in the notification bell needs somewhere to record that a
-- user dismissed an item from their bell/badge — deliberately NOT the same
-- as announcement_reads (the tickbox "I have read and understood this"
-- acknowledgment used for compliance reporting on the Announcements tab).
-- Dismissing from the bell clears the badge; it is never treated as a
-- genuine acknowledgment. notification_key is namespaced per type, e.g.
-- 'announcement:<uuid>', so this table can cover future bell item types
-- without a schema change.
CREATE TABLE IF NOT EXISTS notification_dismissals (
  user_email TEXT NOT NULL,
  notification_key TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_email, notification_key)
);

-- Webex Calling Detailed Call History (CDRs), synced the same way as
-- fathom_meetings: pulled incrementally and persisted so the Workforce
-- Management Dashboard never needs to re-hit the Webex API to recompute
-- stats. Webex's CDR feed has no single globally-unique id per row, so
-- dedup on a composite key of the fields that together uniquely identify a
-- call leg.
CREATE TABLE IF NOT EXISTS webex_cdrs (
  id SERIAL PRIMARY KEY,
  start_time TIMESTAMPTZ NOT NULL,
  answer_time TIMESTAMPTZ,
  duration INTEGER,             -- seconds
  ring_duration INTEGER,        -- seconds between start_time and answer/abandon, if Webex provides it — nullable until confirmed against real data
  calling_number TEXT,
  called_number TEXT,
  user_name TEXT,                -- Webex "User" field — whose call leg this is
  user_email TEXT,                -- resolved against users table where possible
  direction TEXT,                 -- ORIGINATING | TERMINATING
  call_type TEXT,
  answered BOOLEAN,
  correlation_id TEXT,            -- links legs of the same call session together
  client_type TEXT,
  location TEXT,
  raw JSONB,                      -- full raw record, so new fields can be mined later without a re-sync
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (start_time, calling_number, called_number, user_name)
);
CREATE INDEX IF NOT EXISTS idx_webex_cdrs_start_time ON webex_cdrs(start_time);
CREATE INDEX IF NOT EXISTS idx_webex_cdrs_user_email ON webex_cdrs(user_email);

CREATE TABLE IF NOT EXISTS webex_cdr_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- webex_agent_status_state (above) only ever holds each person's CURRENT
-- status — every poll overwrites it, so there is no way to ask "was this
-- person 'on a call' between 2pm and 2:15pm last Tuesday". This table adds
-- that history: one row per status period, closed off (ended_at set) the
-- moment the status changes, so the Workforce Management Dashboard can
-- compare "on a call" periods against actual CDR call windows and flag
-- gaps. Necessarily prospective only — it only has data from whenever this
-- table started being written to, since Webex's own API doesn't expose
-- historical presence.
CREATE TABLE IF NOT EXISTS webex_agent_status_history (
  id SERIAL PRIMARY KEY,
  email CITEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webex_agent_status_history_email ON webex_agent_status_history(email);
CREATE INDEX IF NOT EXISTS idx_webex_agent_status_history_open ON webex_agent_status_history(email) WHERE ended_at IS NULL;

-- Two-stage leave approval: the requester's direct Team Manager (resolved
-- from team_members.manager_id at submit time, cached here rather than
-- re-resolved live so a later org-chart change never rewrites history)
-- approves first, then either Operations Manager (Sophia or Joy — a fixed
-- pool, not derived from the chart) gives final approval. A request whose
-- resolved level-1 approver has no login, or IS already one of the level-2
-- approvers (e.g. Lorie/Adzi's own leave), skips straight to 'pending_final'
-- since a separate level-1 step would just be the same person/pool twice.
CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  user_email CITEXT NOT NULL,
  user_name TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_manager', -- 'pending_manager' | 'pending_final' | 'approved' | 'rejected'
  level1_approver_email CITEXT,
  level1_approver_name TEXT,
  level1_decided_by CITEXT,
  level1_decided_at TIMESTAMPTZ,
  level2_decided_by CITEXT,
  level2_decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user_email ON leave_requests(user_email);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_dates ON leave_requests(start_date, end_date);

-- Team suggestion box. Deliberately flat — one status field admins move
-- along, one feedback field for their response — no voting/comments,
-- kept simple on purpose.
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  submitted_by_email CITEXT NOT NULL,
  submitted_by_name TEXT,
  status TEXT NOT NULL DEFAULT 'new', -- 'new' | 'in_review' | 'in_progress' | 'implemented' | 'not_planned'
  admin_feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_submitted_by ON ideas(submitted_by_email);

-- Screenshots reps paste/attach when submitting an idea — always shown
-- inline (unlike article_files/announcement_files there's no display_mode
-- choice, since these are always images illustrating the idea, not
-- downloadable documents).
CREATE TABLE IF NOT EXISTS idea_files (
  id SERIAL PRIMARY KEY,
  idea_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  filesize INTEGER,
  storage_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idea_files_idea_id ON idea_files(idea_id);

-- Seeded once so the policy is discoverable in the knowledge base the moment
-- the Leave Request feature ships — DO NOTHING on conflict since an admin
-- may have since edited it via the normal Articles UI.
INSERT INTO articles (id, title, summary, content, category, tags, author_email, published)
VALUES (
  'policy-leave-request',
  'Leave Request Policy & Procedure',
  'How to request leave, the 2-week notice requirement, and the approval process.',
  '<h2>1. Purpose</h2><p>This policy sets out how RawTalent team members request leave, how requests are approved, and what happens if leave isn''t requested properly. It applies to all staff.</p><h2>2. Advance Notice — 2 Weeks, No Exceptions</h2><p><strong>Leave must be requested at least two (2) weeks before the first day off.</strong> This gives the team enough time to plan around your absence — reassign calls, cover shifts, and keep things running smoothly for clients and educators.</p><p>The Leave Request calendar in the intranet enforces this automatically: any date within the next two weeks is greyed out and cannot be selected.</p><h2>3. Unapproved Absence Is Unpaid</h2><p>If you don''t come in and haven''t had leave approved in advance through the proper process, that day is treated as <strong>unpaid</strong>. Submitting a request doesn''t guarantee time off until it''s actually approved — check your request status before making other plans.</p><h2>4. How to Apply</h2><ol><li>Go to the intranet and click <strong>🏖️ Leave Request</strong> in the main menu.</li><li>Click <strong>+ Request Leave</strong>.</li><li>Select your dates on the calendar. Anything within the next two weeks is greyed out and can''t be picked.</li><li>Enter a reason for your leave.</li><li>Submit. You''ll be able to track its status on the same page.</li></ol><h2>5. Approval Process</h2><p>Every leave request goes through two levels of approval:</p><ol><li><strong>Level 1 — Your Team Manager.</strong> Lorie approves requests from her direct reports (AM Team); Adzi approves requests from her direct reports (PM Team). This is resolved automatically from the team structure — you don''t need to pick an approver yourself.</li><li><strong>Level 2 — Final Approval.</strong> Once your Team Manager approves, both Sophia and Joy are notified. Either one approving finalises the request.</li></ol><p>If either level rejects the request, it stops there and you''ll be notified with a reason.</p><h2>6. Notifications & the Team Calendar</h2><ul><li>Approvers are notified in-app the moment a request needs their decision.</li><li>Once fully approved, you''ll get a notification confirming your leave.</li><li>Your name is automatically added to the shared <strong>Team Leave Calendar</strong> on your approved dates (e.g. "Dona on Leave"), so everyone can see who''s out and when.</li></ul><h2>7. Questions</h2><p>If you''re unsure whether your leave qualifies, or you have an urgent/short-notice situation, speak to your Team Manager (Lorie or Adzi) directly before submitting.</p>',
  'Policies',
  '["leave", "policy", "HR", "SOP"]'::jsonb,
  'joy@rawtalent.com.au',
  true
) ON CONFLICT (id) DO NOTHING;

-- A short, distinct title separate from the message body — added so the
-- notification bell can show a one-line summary instead of the entire
-- announcement text. Nullable because existing announcements were written
-- before this existed; the app falls back to the first line of the message
-- for those.
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS title TEXT;

-- Leads gathered during educator vetting calls (see the Lead Extraction
-- Process article) — replaces the ClickUp Lead Form. Suburb/state are kept
-- as their own columns (not folded into the street address) so the admin
-- table can filter/display them directly without parsing free text.
-- assigned_workforce_partner is a plain label, not a foreign key — neither
-- current Workforce Partner (Gwen, Justine) has a login in this app, so
-- there's no user account to reference; it's just what the admin sets.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  centre_name TEXT NOT NULL,
  street_address TEXT,
  suburb TEXT,
  state TEXT,
  centre_phone TEXT,
  educator_name TEXT,
  agency_name TEXT,
  number_of_shifts TEXT,
  agency_usage TEXT, -- 'target_temp' | 'high_agency_user'
  position TEXT,
  contact_first_name TEXT,
  contact_last_name TEXT,
  contact_email TEXT,
  submitted_by_email CITEXT NOT NULL,
  submitted_by_name TEXT,
  assigned_workforce_partner TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- Distinguishes a consultant's vetting-call submission from a centre a
-- Workforce Partner/Admin added directly via the Leads table's "Add Centre"
-- button — same table and downstream workflow either way, but not a lead
-- in the pipeline-performance sense, so the UI badges it differently.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'lead'; -- 'lead' | 'centre'
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_submitted_by ON leads(submitted_by_email);

-- Trigram indexes back the fuzzy duplicate-check on the lead submission
-- form (GET /api/leads/check-duplicate) — reps type centre names and
-- addresses inconsistently, so exact matches would miss most duplicates.
CREATE INDEX IF NOT EXISTS idx_leads_centre_name_trgm ON leads USING gin (centre_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_street_address_trgm ON leads USING gin (street_address gin_trgm_ops);

-- Follow-up tracking, admin-editable. Each stage has a status plus an
-- optional date/time — 'scheduled' uses that date/time as the scheduled
-- moment, 'done' uses it as when it actually happened.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_called_status TEXT DEFAULT 'to_schedule';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_called_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS centre_visited_status TEXT DEFAULT 'to_schedule';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS centre_visited_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS signed_status TEXT DEFAULT 'pending';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

-- Geocoding cache for Smart Routing (route-planner service) — populated
-- lazily the first time a lead is included in a route, not eagerly for
-- every lead on submission, since most leads are never routed.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

-- Links a signed centre (entry_type='centre') to its real RT record, for My
-- Centres/Centre 360 (health, booking performance, educator relationships —
-- see services/centreHealthService.js). RT has no field connecting a
-- centre back to "the lead/centre row that created it", so this has to be
-- matched after the fact (services/centreMatchService.js), either
-- automatically (high-confidence name/phone/suburb match) or manually via
-- Centre 360's "Link this centre" picker when nothing matches confidently.
-- rt_location_id (RT's clientsLocationId, matches a Booking's locationId —
-- see the RT API Data Reference page) is the real join key for booking
-- data, not rt_client_id — one RT client can have multiple locations/
-- centres, each a separate leads row here.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS rt_client_id BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS rt_location_id BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS rt_link_source TEXT; -- 'auto' | 'manual'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS rt_linked_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_rt_location_id ON leads(rt_location_id) WHERE rt_location_id IS NOT NULL;

-- "Close out" a lead independently of the Lead Called/Centre Visited/
-- Profile Created pipeline — covers both "fully done, nothing left to
-- track" and "this one's dead, stop chasing it". NULL = still active
-- (the default, shown in the pipeline); set = hidden from the default
-- view but still visible/reopenable via the Closed filter. Deliberately
-- not a boolean — closed_at doubles as "when", closed_by_email as "who".
ALTER TABLE leads ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS closed_by_email TEXT;

-- Set by services/leadAutoSignService.js when it signs a lead on its own,
-- from an RT centre creation, with nobody having touched the lead. Drives
-- a banner/badge in the UI telling the Workforce Partner this was a
-- machine-detected win, not something they logged themselves — they still
-- need to go fill in Lead Called/Centre Visited/recording/notes for real,
-- since the auto-signer only ever sets those to N/A as a safe default, not
-- because a call or visit genuinely didn't happen. auto_signed itself is
-- permanent (the badge always shows how a lead was signed); the
-- reviewed_at/by pair is what clears the "needs attention" state once a
-- Workforce Partner has actually looked at it.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_signed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_signed_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_signed_reviewed_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_signed_reviewed_by CITEXT;

-- A running thread rather than a single overwritable field, since more
-- than one person (a consultant, an admin, eventually a Workforce Partner)
-- may add notes on the same lead over time — a single field would let one
-- author silently clobber another's note. No FK to leads, matching this
-- table's existing (lack of) referential integrity.
CREATE TABLE IF NOT EXISTS lead_notes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  note TEXT NOT NULL,
  author_name TEXT,
  author_email TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_id ON lead_notes(lead_id);

-- Structured post-sign visit records — distinct from the single
-- centre_visited_status/at pair above, which is the one-time pre-sign
-- pipeline transition ("has this lead been visited yet"). A signed centre
-- gets many visits over its lifetime as an ongoing account, each with its
-- own purpose/outcome/next-step, which centre_visited_at (overwritten on
-- every status change) can't represent.
--
-- Keyed by centre_key, not lead_id: "My Centres" is RawTalent's real,
-- live RT client base (~1,100 clients, most predating this app entirely),
-- not just the leads that happen to close through this pipeline — RT's
-- own reporting confirmed 0 leads have ever reached signed_status='signed'
-- in production, so keying visits to a leads row would leave almost every
-- real centre unable to have a visit logged at all. centre_key is
-- 'loc:<clientsLocationId>' for an RT client location, or
-- 'client:<clientId>' for the rarer client with no locations[] on file —
-- see services/centreKeyService.js. No FK anywhere, matching this table
-- family's existing (lack of) referential integrity.
CREATE TABLE IF NOT EXISTS centre_visits (
  id TEXT PRIMARY KEY,
  centre_key TEXT NOT NULL,
  visit_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned', -- 'planned' | 'completed' | 'rescheduled' — shown to users as "Planned"/"Called / Visited"/"Rescheduled"; 'completed' keeps its original DB value (still an accurate internal name) even though its label changed
  purpose TEXT,
  pre_visit_brief TEXT,
  outcome TEXT, -- 'positive' | 'neutral' | 'concern' | 'issue_raised'
  notes TEXT,
  next_step TEXT,
  next_step_due_date DATE,
  created_by_email CITEXT,
  created_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_centre_visits_centre_key ON centre_visits(centre_key);
-- Backs the "overdue next step" signal both Centre 360 and the My
-- Dashboard attention queue need to surface.
CREATE INDEX IF NOT EXISTS idx_centre_visits_next_step_due ON centre_visits(next_step_due_date) WHERE next_step_due_date IS NOT NULL;

-- Site-visit/call recordings & transcripts attached from Centre 360 — same
-- shape as lead_recordings, keyed by centre_key instead of a lead id (see
-- the centre_visits comment above for why centres can't be keyed to a
-- leads row). visit_id links a recording back to the centre_visits row
-- services/centreRecordingService.js auto-creates for it (one visit per
-- upload batch, not per file — dropping a recording and its transcript
-- together documents ONE call/visit) so attaching evidence of contact is
-- itself what gets a centre recognized as called/visited, not a separate
-- manual step. detected_at is the timestamp parsed out of the transcript
-- content when one was found (see transcriptDateService.js) — null means
-- no confident date was found in the file, so the visit fell back to
-- upload time instead.
CREATE TABLE IF NOT EXISTS centre_recordings (
  id SERIAL PRIMARY KEY,
  centre_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  filesize INTEGER,
  storage_path TEXT,
  detected_at TIMESTAMPTZ,
  visit_id TEXT,
  uploaded_by_email CITEXT,
  uploaded_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_centre_recordings_centre_key ON centre_recordings(centre_key);

-- "Delete centre" on My Centres — a centre isn't a local row, it's RT
-- client/location data pulled live, so there's nothing in our own DB to
-- actually delete. Real deletion would mean mutating RT itself, which this
-- app has no business doing on a "get this junk off my list" click. This
-- table just excludes a centreKey from every My Centres/WFP Dashboard
-- query going forward — reversible with a single DELETE from this table,
-- never destroys anything in RT.
CREATE TABLE IF NOT EXISTS hidden_centres (
  centre_key TEXT PRIMARY KEY,
  reason TEXT,
  hidden_by_email CITEXT,
  hidden_by_name TEXT,
  hidden_at TIMESTAMPTZ DEFAULT now()
);

-- Manual per-centre assignment to a Workforce Partner — My Centres isn't
-- split by territory otherwise (see the comment on that section's page
-- header in admin.html), but Liam (RawTalent's owner, no login of his own)
-- wanted his own filtered view of centres he personally visits, alongside
-- Justine/Gwen's existing state-based VIC/SA toggle. Modeled directly on
-- hidden_centres above — tiny, queried fresh each time, reversible.
-- workforce_partner is free text, same permissive convention as
-- leads.assigned_workforce_partner — the frontend dropdown (built from
-- WORKFORCE_PARTNER_OPTIONS) is what actually constrains the choices.
CREATE TABLE IF NOT EXISTS centre_partner_assignments (
  centre_key TEXT PRIMARY KEY,
  workforce_partner TEXT NOT NULL,
  assigned_by_email CITEXT,
  assigned_by_name TEXT,
  assigned_at TIMESTAMPTZ DEFAULT now()
);

-- Territory Strategy (Micropods demand overlay) — RT client/location
-- records have no lat/lng of their own (unlike rt_candidates_cache's
-- addresses, which RT pre-geocodes — see routes/micropods.js), so centres
-- get geocoded here via Mapbox the same way routePlanner.js caches
-- leads.latitude/longitude. A real street address rarely moves, so this is
-- a permanent cache keyed by centreKey, topped up lazily for any centre
-- not yet seen rather than a batch job.
CREATE TABLE IF NOT EXISTS centre_geocodes (
  centre_key TEXT PRIMARY KEY,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  geocoded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Google Calendar sync (Workforce Partner scheduling) ──────────────
-- Links a lead to the calendar event representing its scheduled call or
-- visit, in either direction: 'app' = HeartBeat created/updated the
-- event when a status was set to "scheduled"; 'calendar' = a Workforce
-- Partner created the event by hand and it was fuzzy-matched back to
-- this lead. The unique index is what makes outbound sync idempotent —
-- re-syncing the same lead's same event type updates the existing
-- Google event instead of creating a duplicate.
CREATE TABLE IF NOT EXISTS lead_calendar_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'call' | 'visit'
  google_event_id TEXT NOT NULL,
  calendar_owner_email CITEXT NOT NULL,
  source TEXT NOT NULL, -- 'app' | 'calendar'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_calendar_events_google_id ON lead_calendar_events(google_event_id, calendar_owner_email);
CREATE INDEX IF NOT EXISTS idx_lead_calendar_events_lead_id ON lead_calendar_events(lead_id);

-- Site-visit recordings a Workforce Partner attaches to a lead — any file
-- format (audio, video, whatever they actually captured), stored the same
-- way project_files stores SOP attachments: metadata row here, real bytes
-- in Supabase Storage (BUCKETS.leadRecordings, see storageService.js).
CREATE TABLE IF NOT EXISTS lead_recordings (
  id SERIAL PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  filesize INTEGER,
  storage_path TEXT,
  uploaded_by_email CITEXT,
  uploaded_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_recordings_lead_id ON lead_recordings(lead_id);

-- One row per Workforce Partner calendar being watched — the sync_token
-- is the incremental-fetch cursor Google's events.list returns, so a
-- push notification only has to ask "what changed since sync_token",
-- never re-scan the whole calendar. channel_id/resource_id/expires_at
-- track the active push-notification subscription so it can be renewed
-- before Google expires it.
CREATE TABLE IF NOT EXISTS calendar_watch_state (
  calendar_owner_email CITEXT PRIMARY KEY,
  sync_token TEXT,
  channel_id TEXT,
  resource_id TEXT,
  channel_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Inbound calendar events that couldn't be confidently matched to a
-- lead (below the fuzzy-match threshold, or two leads scored almost
-- identically) land here instead of guessing — resolved manually via
-- the admin panel once that UI exists.
CREATE TABLE IF NOT EXISTS calendar_sync_review_queue (
  id TEXT PRIMARY KEY,
  google_event_id TEXT NOT NULL,
  calendar_owner_email CITEXT NOT NULL,
  event_title TEXT,
  event_type TEXT,
  candidate_lead_id TEXT,
  candidate_score REAL,
  reason TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Document Checker — deterministic (no AI) validation of compliance
-- documents (Police Check first; more document types get their own rule
-- set in services/documentCheckerService.js over time) against the actual
-- SOPs in our Articles. Documents come from the RT API — a candidate's own
-- attachedRequirements[] (documentPath is a fetchable URL, e.g. an S3
-- link) — never uploaded manually. extracted_fields/flags/reasons are the
-- checker's output, kept so a reviewer can see exactly why something was
-- flagged without re-running the check. extracted_text is capped in the
-- app layer before insert. One row per check RUN (append-only, like RT's
-- own Recheck concept) — the UI shows the latest row per
-- user_document_detail_id; reviewed/review_notes belong to that specific
-- automated result, not the requirement in general, so re-checking a
-- document naturally starts its review state fresh.
CREATE TABLE IF NOT EXISTS document_checks (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL, -- 'police_check' (more types added over time)
  filename TEXT NOT NULL,
  storage_path TEXT,
  extraction_method TEXT, -- 'pdf-text-layer' | 'tesseract-ocr'
  ocr_confidence INTEGER, -- 0-100, only set for tesseract-ocr; null for a real PDF text layer
  candidate_name_input TEXT,
  outcome TEXT NOT NULL, -- 'valid' | 'needs_review' | 'invalid'
  flags JSONB DEFAULT '[]',
  reasons JSONB DEFAULT '[]',
  extracted_fields JSONB DEFAULT '{}',
  extracted_text TEXT,
  checked_by_email CITEXT NOT NULL,
  checked_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- RT-sourced context — nullable so the table also still supports a
-- freestanding check with no candidate context if that's ever needed again.
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS candidate_id BIGINT;
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS user_document_detail_id BIGINT;
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS requirement_name TEXT;
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS document_source_url TEXT;
-- Human review layer on top of the automated result.
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS reviewed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE document_checks ADD COLUMN IF NOT EXISTS review_notes TEXT;
CREATE INDEX IF NOT EXISTS idx_document_checks_created_at ON document_checks(created_at);
CREATE INDEX IF NOT EXISTS idx_document_checks_outcome ON document_checks(outcome);
CREATE INDEX IF NOT EXISTS idx_document_checks_candidate ON document_checks(candidate_id);
CREATE INDEX IF NOT EXISTS idx_document_checks_requirement ON document_checks(user_document_detail_id);

-- Local mirror of RT's Candidates report — RT's API has no server-side name
-- search and no "updated since" field (only createdDate), so the only way
-- to know what changed on an EXISTING candidate is a full re-fetch. This
-- table exists purely to make the Candidates list/search fast (a live full
-- fetch is ~25k records, ~60s+) — it is NEVER the source of truth for a
-- specific candidate's actual current documents. Opening one candidate
-- (Candidate detail, Document Checker) always re-fetches that one record
-- live from RT regardless of how stale this table is, so compliance
-- accuracy is never affected by sync staleness — only browsing/search
-- speed is. Refreshed by a full nightly re-sync (services/
-- rtCandidatesSyncService.js), replacing the whole table's contents in one
-- transaction so a reader never sees a half-old-half-new mix.
CREATE TABLE IF NOT EXISTS rt_candidates_cache (
  user_id BIGINT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  email CITEXT,
  contact_no TEXT,
  is_active BOOLEAN,
  is_deleted BOOLEAN,
  status INTEGER,
  suburb TEXT,
  created_date TIMESTAMPTZ,
  expiring_docs_count INTEGER NOT NULL DEFAULT 0,
  raw JSONB NOT NULL, -- the full RT candidate record, exact same shape RT's own API returns (addresses/qualifications/availableCandidateList/attachedRequirements all nested inside) — so callers can't tell whether a list came from here or a live fetch
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rt_candidates_cache_name_trgm ON rt_candidates_cache USING gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_rt_candidates_cache_email_trgm ON rt_candidates_cache USING gin (email gin_trgm_ops);
-- Digits-only so a search for "0421 413 425" or "+61421413425" matches a
-- phone stored as either, without the caller having to normalise anything.
CREATE INDEX IF NOT EXISTS idx_rt_candidates_cache_phone_trgm ON rt_candidates_cache USING gin ((regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_rt_candidates_cache_active ON rt_candidates_cache(is_active);
CREATE INDEX IF NOT EXISTS idx_rt_candidates_cache_synced_at ON rt_candidates_cache(synced_at);

-- Singleton row (id is always 1) tracking the sync job itself — lets the
-- admin UI show "last synced X ago" / "sync failed: ..." and stops two
-- syncs (the nightly schedule and a manual "Sync Now") from ever running
-- at the same time and racing each other.
CREATE TABLE IF NOT EXISTS rt_candidates_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'running' | 'success' | 'failed'
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  candidate_count INTEGER,
  duration_ms INTEGER,
  error_message TEXT,
  triggered_by TEXT, -- 'schedule' or the super_admin's email for a manual Sync Now
  CONSTRAINT rt_candidates_sync_state_singleton CHECK (id = 1)
);
INSERT INTO rt_candidates_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Saved, named educator outreach lists (Decision Area 1, 2026-08-22) —
-- LIST-BUILDING ONLY. HeartBeat has no send capability yet (Joy, on the
-- meeting recording: "the heartbeat is not yet built to send outreach").
-- Deliberately no sent_at/message/template/approval columns — that
-- contract isn't designed yet; add an approval-status column here when the
-- send feature is actually built (the meeting's own rule: a send to more
-- than one educator needs admin-tier approval first).
CREATE TABLE IF NOT EXISTS educator_outreach_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT,
  source_pod_id TEXT,
  source_segment TEXT,
  created_by CITEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outreach_lists_created_by ON educator_outreach_lists(created_by);

-- Snapshot, not a live join — rt_candidates_cache is fully replaced every
-- nightly sync, so storing only user_id would silently shrink an
-- already-built list as RT records disappear/change. name/email/contact/
-- segment are frozen at build time. The ON DELETE CASCADE here is a
-- deliberate, commented exception to this app's usual "no FKs" convention
-- (see schema.sql's header note) — this is an owned child table where
-- cascade delete is the actual point.
CREATE TABLE IF NOT EXISTS educator_outreach_list_members (
  list_id TEXT NOT NULL REFERENCES educator_outreach_lists(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  name TEXT,
  email CITEXT,
  contact_no TEXT,
  suburb TEXT,
  segment TEXT,
  added_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_review_unresolved ON calendar_sync_review_queue(resolved) WHERE resolved = false;

-- Tasks (2026-08-23) — replaces ClickUp for internal task tracking.
-- Visible to EVERY signed-in user regardless of role (built into
-- public/index.html, not admin.html — role `user` has no admin panel
-- access at all). Deliberately simple: a fixed 5-department list, a fixed
-- 5-value status set, and user-addable classifications *within* a
-- department — matching the explicit "don't make this harder than it
-- needs to be" instruction, rather than ClickUp's fully custom
-- lists/statuses/fields. No FKs, per this file's header convention.
CREATE TABLE IF NOT EXISTS task_departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0
);
INSERT INTO task_departments (id, name, color, icon, sort_order) VALUES
  ('bookings', 'Bookings Team', '#2563eb', '📅', 1),
  ('onboarding', 'Onboarding Team', '#15803d', '🧑‍🎓', 2),
  ('app_dev', 'App Development Team', '#7c3aed', '💻', 3),
  ('management', 'Management Team', '#b45309', '📊', 4),
  ('marketing', 'Marketing Team', '#db2777', '📣', 5)
ON CONFLICT (id) DO NOTHING;

-- User-addable sub-categories within a department (e.g. "Bookings Team" ->
-- "Follow-ups", "Rosters"). Not seeded — starts empty per department, grows
-- as people add what they actually need.
CREATE TABLE IF NOT EXISTS task_classifications (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by CITEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_classifications_department ON task_classifications(department_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  classification_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'to_do', -- 'to_do' | 'in_progress' | 'blocked' | 'in_review' | 'done'
  priority TEXT NOT NULL DEFAULT 'normal', -- 'low' | 'normal' | 'high' | 'urgent'
  assigned_to CITEXT, -- users.email; null = unassigned
  due_date DATE,
  created_by CITEXT NOT NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_department ON tasks(department_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

-- Free-form notes on a task, ClickUp-style — a task can have many. Records
-- who wrote it and when (created_at is UTC; the frontend renders it in
-- Melbourne time, same convention as everywhere else in this codebase —
-- see MELBOURNE_TZ in routes/calls.js). mentioned_emails captures anyone
-- @tagged in the note body so the notification bell can alert them.
CREATE TABLE IF NOT EXISTS task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author_email CITEXT NOT NULL,
  author_name TEXT,
  mentioned_emails JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id);
