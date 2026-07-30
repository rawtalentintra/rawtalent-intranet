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
-- Per-user grant, not a role — Build Training needs to be handed to one
-- specific person (e.g. Sophia) without opening it to every admin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_build_training BOOLEAN DEFAULT false;

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
