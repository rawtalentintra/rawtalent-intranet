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

## Known issue: Chrome GPU compositor bug on scaled macOS displays

Spent a long session (2026-08-11) chasing a "blank navbar/sidebar/table content" bug
that turned out to be a real Chromium bug, not app code — see commit `594aceb` and
the ones just before it for the full investigation. It only reproduces on Chrome on
a MacBook's built-in Retina display set to a **non-native/scaled resolution**
(anything except the display's actual default) — never on Safari, never on an
external monitor at native resolution, and disabling GPU rasterization alone did
NOT fix it. Root cause: fractional macOS display scaling means the physical pixel
grid doesn't align with Chrome's GPU compositor tile grid, so a tile drops and
flashes the page background through mid-repaint.

**When adding new CSS, avoid reintroducing the triggers:**
- Don't add `backdrop-filter` anywhere (removed from `.modal-overlay` for this
  reason). If a blur effect is genuinely needed, test it at a scaled resolution on
  a MacBook first.
- Don't add `will-change` or `transform: translateZ(0)`/`translate3d(...)` as a
  "GPU speed" trick — on this bug, they make it *worse*, not better.
- Any new `position: fixed` (or `sticky`) element that spans a large area (a
  header, sidebar, persistent panel) should get `contain: paint;
  transform-style: flat;` alongside it, matching `.navbar`/`.admin-sidebar` in
  `public/css/style.css` — isolates its paint into one GPU layer instead of
  letting Chrome split it into sub-tiles that can desync.
- Keep explicit `background-color` on `html`/`body`/any full-page wrapper — never
  rely on the default transparent background, since that's what a dropped tile
  flashes through to.

If "blank/flashing content, Chrome-only, doesn't reproduce in the recording,
reporter mentions a MacBook" comes up again: ask what physical display it's on
and whether it's at native or scaled resolution before assuming it's an app bug.
