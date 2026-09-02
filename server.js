require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initDatabase, getDb } = require('./db/database');
const { syncFromDrive } = require('./services/driveService');
const PgSessionStore = require('./services/sessionStore');
const webexService = require('./services/webexService');
const dubberService = require('./services/dubberService');
const calendarSync = require('./services/leadCalendarSyncService');
const rtCandidatesSync = require('./services/rtCandidatesSyncService');
const rtApiService = require('./services/rtApiReportService');
const leadAutoSignService = require('./services/leadAutoSignService');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS,
// Referrer-Policy, etc. all come from helmet's defaults). CSP is hand-built
// rather than left default because the frontend is plain inline-<script>
// HTML with no build step — 'unsafe-inline' on script-src is a deliberate,
// known trade-off, not an oversight: a real nonce/hash-based policy would
// need every inline handler in views/*.html rewritten first. What this
// still buys us: frame-ancestors blocks clickjacking (the login page is the
// obvious target), object-src/base-uri close two classic injection
// sideChannels, and everything else is restricted to the small, real list
// of external hosts this app actually loads (Google Fonts, the DOMPurify
// CDN script, Mapbox GL JS for Smart Routing). COEP/CORP are turned off —
// their strict defaults block cross-origin font/tile loads from the hosts
// above and this app has no cross-origin isolation requirement to justify
// the breakage.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // esm.sh is where public/js/richEditor.js imports TipTap (the rich
      // text editor for articles/SOPs) as native ES modules — found by
      // actually exercising the admin panel with the CSP live, not by
      // grepping HTML for <script src>, since these are JS-level import
      // statements.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://api.mapbox.com', 'https://esm.sh'],
      // helmet's own defaults set this to 'none', which would silently break
      // every onclick="..." (and similar) attribute in views/*.html — this
      // whole app is built on inline event-handler attributes. Must match
      // scriptSrc's 'unsafe-inline' trade-off, not the stricter default.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://api.mapbox.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://api.mapbox.com', 'https://events.mapbox.com', 'https://*.tiles.mapbox.com'],
      workerSrc: ["'self'", 'blob:'],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false
}));

// Login is the one endpoint an attacker can hammer without already holding
// a valid session — cap attempts per IP so credential stuffing/brute force
// costs real time instead of being free. Counts failed AND successful
// attempts the same way (simplest correct option); a legitimate user
// mistyping their password a few times in 15 minutes is not meaningfully
// affected by a 20-attempt window.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' }
});

// Skip compression for SSE (Ask AI streaming) — gzip buffers chunks until it
// has enough data to compress, which would turn the token-by-token typing
// effect into occasional large bursts instead of a smooth stream.
app.use(compression({
  filter: (req, res) => {
    if (String(res.getHeader('Content-Type')).includes('event-stream')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSessionStore(),
  secret: process.env.SESSION_SECRET || 'rt-kb-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    // Explicit rather than relying on the browser's own unset-cookie
    // default — 'lax' still allows normal top-level navigation (clicking a
    // link into the app) while blocking the cookie from being sent on
    // cross-site requests a malicious page might trigger (CSRF).
    sameSite: 'lax',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

// `index: false` matters here, not just cosmetically — without it,
// express.static auto-serves public/index.html for GET '/' itself, before
// the request ever reaches the guardRoute-protected app.get('/') below,
// which would silently defeat the entire app's authentication check. The
// three authenticated page shells (index/admin/article) deliberately live
// outside public/, in views/, and are only ever served via guardRoute()'s
// own res.sendFile below — never through this static mount.
// no-store on the manifest specifically (2026-09-02, same "still shows RT
// Partner" chase as wfpGuard's own no-store above) — it's small and rarely
// changes, exactly the kind of response a cache holds onto longest, and
// it's one of the couple of places the OS's "Add to Home Screen" naming
// could plausibly be reading from. Registered before the static mount so
// it wins; everything else under public/wfp/ (icons, sw.js) is unaffected.
app.get('/wfp/manifest.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'wfp', 'manifest.json'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/auth/login', loginLimiter);
app.use('/auth', require('./routes/auth'));
app.use('/api/articles', require('./routes/articles'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/faq', require('./routes/faq'));
app.use('/api/calls', require('./routes/calls'));
app.use('/api/team', require('./routes/team'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/workforce', require('./routes/workforce'));
app.use('/api/training', require('./routes/training'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/leave-requests', require('./routes/leaveRequests'));
app.use('/api/timesheets', require('./routes/timesheets'));
app.use('/api/payslips', require('./routes/payslips'));
app.use('/api/ideas', require('./routes/ideas'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/centres', require('./routes/centres'));
app.use('/api/educators', require('./routes/educators'));
app.use('/api/micropods', require('./routes/micropods'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/calendar-sync', require('./routes/calendarSync'));
app.use('/api/route-planner', require('./routes/routePlanner'));
app.use('/api/document-checker', require('./routes/documentChecker'));
app.use('/api/outreach-lists', require('./routes/outreachLists'));
app.use('/api/tasks', require('./routes/tasks'));
// MCP Custom Connector — /mcp uses its own bearer-token auth (see
// routes/mcp.js), not the session cookie every other route above relies
// on; /api/mcp-tokens is the ordinary session-authenticated Settings UI
// for generating/revoking those tokens.
app.use('/mcp', require('./routes/mcp'));
app.use('/api/mcp-tokens', require('./routes/mcpTokens'));
// OAuth discovery/authorize/token/register for the Custom Connector flow
// above — root-mounted, not under /mcp, since /.well-known/... is
// origin-scoped and /authorize|/token|/register are conventionally
// root-level too. See routes/mcpOAuth.js's header comment.
app.use('/', require('./routes/mcpOAuth'));

// 'qa_view' gets into the admin panel shell — the panel itself then hides
// everything except the small set of sections that role is scoped to
// (articles, FAQ management, call quality), enforced both client-side and
// on every underlying API route.
function guardRoute(req, res, file, adminOnly = false) {
  if (!req.isAuthenticated()) return res.redirect('/login.html');
  if (adminOnly && !['admin', 'super_admin', 'qa_view', 'workforce_partner'].includes(req.user.role)) {
    return res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
  }
  // These three page shells live in views/, not public/, specifically so
  // they can never be reached by a direct static-file request that skips
  // this auth check (see the express.static comment above).
  res.sendFile(path.join(__dirname, 'views', file));
}

// Safety net: an unwrapped `await` in a route handler that rejects becomes
// an unhandled rejection, not a caught Express error — without this, Node
// terminates the whole process (and every other in-flight request) over one
// bad request instead of just failing that request.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

// A workforce_partner-role account has no real use for the full HeartBeat
// homepage — landing there was the actual bug Joy flagged (2026-09-01):
// "/" should go straight to their focused view instead. Points at /wfp,
// not /partners — same restricted content either way (see wfpGuard's own
// comment), but /wfp is also the installable PWA, so this is where the
// "Add to Home Screen" prompt actually shows up. Only touches the
// workforce_partner role itself — admin/super_admin still get the full
// homepage at "/" even though they can also visit /wfp or /partners
// directly, and a plain user with just can_use_wfp_pwa was never sent
// here via role anyway (they land on "/" as a normal 'user' account,
// same as before — this redirect is keyed off role, not the grant).
app.get('/', (req, res) => {
  if (req.isAuthenticated() && req.user.role === 'workforce_partner') return res.redirect('/wfp');
  guardRoute(req, res, 'index.html');
});
app.get('/article', (req, res) => guardRoute(req, res, 'article.html'));
app.get('/admin', (req, res) => guardRoute(req, res, 'admin.html', true));
app.get('/admin/*', (req, res) => guardRoute(req, res, 'admin.html', true));

// /allapp (Joy, 2026-09-01) — a plain additional alias for the exact same
// full admin panel /admin already serves (same file, same guard) — /admin
// itself keeps working unchanged, nothing existing breaks. Exists purely
// so "the complete app, everything" has its own memorable URL to
// contrast with /partners below (the new narrow Workforce-Partners-only
// view of this same file).
app.get('/allapp', (req, res) => guardRoute(req, res, 'admin.html', true));
app.get('/allapp/*', (req, res) => guardRoute(req, res, 'admin.html', true));

// /partners — the SAME admin.html file as /admin (not a separate view to
// build/maintain), restricted client-side to just the Workforce Partners
// nav group (WFP Dashboard, Leads, My Centres, Micropods, Smart Routing —
// see admin.html's IS_PARTNERS_VIEW/PARTNERS_VIEW_SECTIONS). The
// distinction is which route the request came in on, not a different
// file or a different auth rule — same guard as /admin/allapp.
app.get('/partners', (req, res) => guardRoute(req, res, 'admin.html', true));
app.get('/partners/*', (req, res) => guardRoute(req, res, 'admin.html', true));

// Workforce Partner PWA (Aug 26 meeting; repointed at admin.html 2026-09-02
// — Joy: "/wfp should be the same as /partners... standalone installable").
// Same session cookie as everywhere else (no separate login/token scheme).
// Serves the exact same file as /partners (restricted client-side to the
// Workforce Partners nav group — see admin.html's IS_PARTNERS_VIEW/
// PARTNERS_VIEW_SECTIONS) rather than the earlier standalone views/wfp.html
// shell, which this replaces — that file and its own /api/centres/
// :key/snapshot, /api/educators/* endpoints are unused now but left in
// place rather than deleted outright. Access is /partners' own four-role
// check, PLUS (this route only) a plain 'user' account Joy granted
// can_use_wfp_pwa to — matches requirePwaAccess (middleware/
// authMiddleware.js), the same check routes/centres.js/educators.js use to
// gate the APIs the My Centres section actually calls; Leads/Micropods/
// Smart Routing's own routes don't extend that same grant yet (pre-
// existing — qa_view has the identical gap at /partners today), so a
// can_use_wfp_pwa-only account can open this shell and use My Centres, but
// would 403 on those three sections until that's extended too. Static
// assets under public/wfp/ (manifest, service worker, icons) are already
// reachable via the express.static mount above — nothing in them is
// sensitive — only the app shell itself needs the auth check.
function wfpGuard(req, res) {
  if (!req.isAuthenticated()) return res.redirect('/login.html');
  const hasAccess = ['admin', 'super_admin', 'qa_view', 'workforce_partner'].includes(req.user.role) || req.user.can_use_wfp_pwa;
  if (!hasAccess) return res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
  // Explicit no-store (2026-09-02, chasing the "still shows RT Partner"
  // report) — res.sendFile sets Last-Modified/ETag by default but no
  // Cache-Control, which is enough for Safari/an intermediate cache to
  // hold onto a stale copy of this document rather than always
  // revalidating. Ruling that out entirely; the real suspected culprit is
  // the service worker (see public/wfp/sw.js's own v3 comment), this is
  // just cheap, unconditional insurance alongside it.
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
}
app.get('/wfp', wfpGuard);
app.get('/wfp/*', wfpGuard);

// Short "Copy Link" URLs for Tasks — resolves a code minted by
// routes/tasks.js's POST /:id/short-link and redirects to the real
// ?tab=tasks&task=<uuid> deep link. Same auth requirement as every other
// page here; an unknown code (its task was deleted, or it was just made
// up) 404s in plain text rather than redirecting into a broken task view.
app.get('/t/:code', async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/login.html');
  try {
    const result = await getDb().execute({ sql: 'SELECT task_id FROM task_short_links WHERE code = ?', args: [req.params.code] });
    const row = result.rows[0];
    if (!row) return res.status(404).send('This link is invalid or has expired.');
    res.redirect(`/?tab=tasks&task=${row.task_id}`);
  } catch (err) {
    res.status(500).send('Something went wrong loading this link.');
  }
});

const RT_CANDIDATES_SYNC_TZ = 'Australia/Melbourne';
async function maybeRunNightlyCandidatesSync() {
  const state = await rtCandidatesSync.getSyncState();
  if (rtCandidatesSync.isSyncRunning(state)) return;

  const nowMelbourne = new Date(new Date().toLocaleString('en-US', { timeZone: RT_CANDIDATES_SYNC_TZ }));
  if (nowMelbourne.getHours() !== 2) return; // only inside the 2-3am Melbourne window

  const lastRunDay = state?.started_at
    ? new Date(new Date(state.started_at).toLocaleString('en-US', { timeZone: RT_CANDIDATES_SYNC_TZ })).toDateString()
    : null;
  if (lastRunDay === nowMelbourne.toDateString()) return; // already ran today

  console.log('Starting nightly RT candidates sync…');
  try {
    const { count, durationMs } = await rtCandidatesSync.syncAllCandidates('schedule');
    console.log(`Nightly RT candidates sync complete — ${count} candidates in ${Math.round(durationMs / 1000)}s.`);
  } catch (err) {
    console.error('Nightly RT candidates sync failed:', err.message);
  }
}

async function start() {
  await initDatabase();
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY && process.env.DRIVE_FOLDER_ID) {
    syncFromDrive().catch(err => console.error('Drive sync error:', err.message));
  }
  // initDatabase() only clears expired sessions on boot — keep sweeping
  // periodically too, since a process can run for weeks between deploys.
  setInterval(() => {
    getDb().execute({ sql: 'DELETE FROM sessions WHERE expires IS NOT NULL AND expires < ?', args: [Date.now()] })
      .catch(err => console.error('Session cleanup error:', err.message));
  }, 6 * 60 * 60 * 1000);
  // Agent status "since" timestamps used to only update while someone had the
  // Workforce Queue tab open and polling — with nobody watching for hours,
  // "time in status" effectively just meant "since I opened this page,"
  // which isn't a reliable duration. Polling here independently of any
  // browser session means the DB always reflects the real transition time.
  if (webexService.isConfigured()) {
    webexService.getAgentStatuses().catch(err => console.error('Webex agent status poll error:', err.message));
    setInterval(() => {
      webexService.getAgentStatuses().catch(err => console.error('Webex agent status poll error:', err.message));
    }, 20 * 1000);
    // Call History (CDRs) used to only refresh when an admin clicked "Sync
    // Calls Now" — fine for the Workforce Management Dashboard's own
    // reporting, but the Workforce Queue's "last call" direction indicator
    // needs this reasonably fresh on its own, not stale by however long
    // since someone last opened that admin page. syncCallHistory is
    // incremental (only pulls new records since last sync), so polling it
    // every 5 minutes is cheap.
    webexService.syncCallHistory('auto-sync').catch(err => console.error('Webex CDR auto-sync error:', err.message));
    setInterval(() => {
      webexService.syncCallHistory('auto-sync').catch(err => console.error('Webex CDR auto-sync error:', err.message));
    }, 5 * 60 * 1000);
  }
  // Call Quality Evaluator's "Sync Calls Now" is manual-only again — the
  // 15-minute background auto-sync introduced glitches for evaluators
  // actively grading a call (a mid-session refetch landing under them).
  // Reverted; the manual button (routes/calls.js) is unaffected.
  // Renews Google Calendar push-notification channels before their ~30-day
  // expiry, and registers new ones for any partner missing a channel (e.g.
  // right after a partner first connects). No-ops entirely until at least
  // one partner is connected (delegation configured, or an oauth
  // connection exists), so it's always safe to run.
  if (Object.keys(await calendarSync.getPartnerCalendarMap()).length) {
    calendarSync.renewWatchesNearingExpiry().catch(err => console.error('Calendar watch renewal error:', err.message));
    setInterval(() => {
      calendarSync.renewWatchesNearingExpiry().catch(err => console.error('Calendar watch renewal error:', err.message));
    }, 12 * 60 * 60 * 1000);
  }
  if (rtApiService.isConfigured()) {
    // First-ever boot (or a wiped cache) would otherwise show an empty
    // Candidates list until the next 2am window — bootstrap it once
    // immediately instead. Steady-state deploys/restarts skip this (cache
    // already has rows) so redeploying never triggers an unwanted extra
    // sync outside the nightly schedule.
    getDb().execute('SELECT count(*) AS n FROM rt_candidates_cache').then(r => {
      if (Number(r.rows[0].n) === 0) {
        console.log('RT candidates cache is empty — running an initial sync…');
        rtCandidatesSync.syncAllCandidates('initial-bootstrap').catch(err => console.error('Initial RT candidates sync error:', err.message));
      }
    }).catch(err => console.error('RT candidates cache check error:', err.message));

    // Checked every 30 min rather than computing a precise next-run delay —
    // simpler, and self-correcting across a redeploy or a missed tick,
    // which a one-shot setTimeout-until-2am wouldn't be. Runs once per
    // Melbourne calendar day, inside the 2-3am window, gated on the sync
    // job's own started_at so a restart mid-window can't double-trigger it.
    setInterval(() => {
      maybeRunNightlyCandidatesSync().catch(err => console.error('Nightly RT candidates sync check error:', err.message));
    }, 30 * 60 * 1000);

    // Catches a lead the moment its centre actually gets created in RT
    // (a Workforce Partner converting it) instead of waiting on someone to
    // remember to flip Profile Created by hand. Runs once on boot too, not
    // just the interval, so a deploy doesn't leave a same-day conversion
    // waiting up to 15 minutes for the first tick.
    const runLeadAutoSignCheck = () => leadAutoSignService.checkAndAutoSignLeads()
      .then(({ checked, signed }) => { if (signed) console.log(`Lead auto-sign: ${signed} of ${checked} pending leads matched a newly-created RT centre.`); })
      .catch(err => console.error('Lead auto-sign check error:', err.message));
    runLeadAutoSignCheck();
    setInterval(runLeadAutoSignCheck, 15 * 60 * 1000);
  }
  app.listen(PORT, () => {
    console.log(`\n🚀 RawTalent Knowledge Base → http://localhost:${PORT}`);
    console.log(`   Admin: ${process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au'}\n`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
