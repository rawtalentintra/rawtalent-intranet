require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const path = require('path');

const { initDatabase, getDb } = require('./db/database');
const { syncFromDrive } = require('./services/driveService');
const PgSessionStore = require('./services/sessionStore');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
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

function guardRoute(req, res, file, adminOnly = false) {
  if (!req.isAuthenticated()) return res.redirect('/login.html');
  if (adminOnly && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
  }
  res.sendFile(path.join(__dirname, 'public', file));
}

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
  app.listen(PORT, () => {
    console.log(`\n🚀 RawTalent Knowledge Base → http://localhost:${PORT}`);
    console.log(`   Admin: ${process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au'}\n`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
