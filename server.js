require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const path = require('path');
const compression = require('compression');

const { initDatabase, getDb } = require('./db/database');
const { syncFromDrive } = require('./services/driveService');
const PgSessionStore = require('./services/sessionStore');
const webexService = require('./services/webexService');
const dubberService = require('./services/dubberService');
const calendarSync = require('./services/leadCalendarSyncService');
const rtCandidatesSync = require('./services/rtCandidatesSyncService');
const rtApiService = require('./services/rtApiReportService');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
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
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, 'public')));

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
app.use('/api/ideas', require('./routes/ideas'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/calendar-sync', require('./routes/calendarSync'));
app.use('/api/route-planner', require('./routes/routePlanner'));
app.use('/api/document-checker', require('./routes/documentChecker'));

// 'qa_view' gets into the admin panel shell — the panel itself then hides
// everything except the small set of sections that role is scoped to
// (articles, FAQ management, call quality), enforced both client-side and
// on every underlying API route.
function guardRoute(req, res, file, adminOnly = false) {
  if (!req.isAuthenticated()) return res.redirect('/login.html');
  if (adminOnly && !['admin', 'super_admin', 'qa_view', 'workforce_partner'].includes(req.user.role)) {
    return res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
  }
  res.sendFile(path.join(__dirname, 'public', file));
}

// Safety net: an unwrapped `await` in a route handler that rejects becomes
// an unhandled rejection, not a caught Express error — without this, Node
// terminates the whole process (and every other in-flight request) over one
// bad request instead of just failing that request.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

app.get('/', (req, res) => guardRoute(req, res, 'index.html'));
app.get('/article', (req, res) => guardRoute(req, res, 'article.html'));
app.get('/admin', (req, res) => guardRoute(req, res, 'admin.html', true));
app.get('/admin/*', (req, res) => guardRoute(req, res, 'admin.html', true));

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
  // right after CALENDAR_PARTNER_MAP is first configured). No-ops entirely
  // until domain-wide delegation is authorized, so it's always safe to run.
  if (calendarSync.getPartnerCalendarMap && Object.keys(calendarSync.getPartnerCalendarMap()).length) {
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
  }
  app.listen(PORT, () => {
    console.log(`\n🚀 RawTalent Knowledge Base → http://localhost:${PORT}`);
    console.log(`   Admin: ${process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au'}\n`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
