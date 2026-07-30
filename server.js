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

// 'qa_view' gets into the admin panel shell — the panel itself then hides
// everything except the small set of sections that role is scoped to
// (articles, FAQ management, call quality), enforced both client-side and
// on every underlying API route.
function guardRoute(req, res, file, adminOnly = false) {
  if (!req.isAuthenticated()) return res.redirect('/login.html');
  if (adminOnly && !['admin', 'super_admin', 'qa_view'].includes(req.user.role)) {
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
  }
  app.listen(PORT, () => {
    console.log(`\n🚀 RawTalent Knowledge Base → http://localhost:${PORT}`);
    console.log(`   Admin: ${process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au'}\n`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
