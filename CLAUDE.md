# RawTalent Knowledge Base

Internal intranet/knowledge-base tool for RawTalent, a childcare staffing agency. Node.js/Express monolith, server-rendered vanilla JS frontend, Postgres via Supabase.

## Stack

- **Backend**: Node/Express, routes under `routes/*.js`, business logic under `services/*.js`
- **DB**: Postgres via Supabase (`db/database.js`, schema in `db/schema.sql`)
- **Auth**: Passport (local + Google OAuth), sessions; `config/passport.js` caches deserialized users for `USER_CACHE_TTL_MS` (20s) — role/permission changes take up to 20s to apply to an already-logged-in session
- **File storage**: Supabase Storage, private buckets + signed URLs (team photos, article attachments, call recording audio, project SOP files, announcement attachments)
- **AI**: `@anthropic-ai/sdk`, powers Ask AI, FAQ candidate classification, call grading, meeting Q&A, report generation
- **Frontend**: plain HTML/CSS/JS under `public/` — no build step, no framework
- **Deployment**: Railway (project `rawtalent-knowledgebase`, service `web`, `production` environment), auto-deploys on push to `main`, live at `rawtalent-internal.app`. `fly.toml`/`Procfile` in this repo are stale leftovers from an abandoned Fly.io attempt — ignore them.

## Roles

`user` < `qa_view` (narrow admin-panel scope: articles, FAQ management, call quality) < `admin` < `super_admin`.

- **super_admin is a singleton** — currently only one account holds it. Never create a second super_admin account, including for testing. Temporary test/verification accounts use role `admin` (never `super_admin`), and must be deleted from the `users` table after use, before committing.
- Per-user feature grants (distinct from role tiers) use a boolean column pattern, e.g. `can_build_training` + `requireTrainingBuilder` middleware — for handing one feature to a specific person without opening it to a whole role tier. Reuse this pattern for similar single-person grants rather than inventing a new role.

## Conventions

- `.env` holds secrets (Supabase DB creds, `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`) — git-ignored, never commit. Production values live in Railway's Variables tab, set independently.
- No ORM — raw SQL via the `db` client (`getDb().execute({ sql, args })`).
- Prefer small, targeted route/middleware additions over new abstractions.
