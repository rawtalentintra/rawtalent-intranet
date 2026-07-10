const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

passport.serializeUser((user, done) => done(null, user.id));

// Every authenticated request deserializes the user, which is otherwise a
// remote DB round trip per request — a single page load easily fires 5-10
// API calls in parallel, each paying that cost separately. A short TTL cache
// removes the repeat cost within one page load / a few seconds of activity,
// while still picking up role/active changes (e.g. impersonation, disabling
// an account) within a few seconds rather than requiring a full re-login.
const USER_CACHE_TTL_MS = 20 * 1000;
const userCache = new Map(); // id -> { user, expiresAt }

function invalidateUserCache(id) {
  userCache.delete(id);
}

passport.deserializeUser(async (id, done) => {
  try {
    const cached = userCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return done(null, cached.user);
    }
    const result = await getDb().execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
    const user = result.rows[0] || false;
    userCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    done(null, user);
  } catch (err) {
    done(err);
  }
});

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT * FROM users WHERE email = ? AND active = 1',
      args: [email.toLowerCase().trim()]
    });
    const user = result.rows[0];
    if (!user || !user.password_hash) {
      return done(null, false, { message: 'Invalid email or password.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return done(null, false, { message: 'Invalid email or password.' });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

module.exports.invalidateUserCache = invalidateUserCache;

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: (process.env.APP_URL || 'http://localhost:3000') + '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email || !email.endsWith('@rawtalent.com.au')) {
        return done(null, false, { message: 'Only @rawtalent.com.au accounts are permitted.' });
      }

      const db = getDb();
      let userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
      let user = userRes.rows[0];

      if (!user) {
        await db.execute({
          sql: `INSERT INTO users (email, name, google_id, role, active) VALUES (?, ?, ?, 'user', 1)`,
          args: [email, profile.displayName || email.split('@')[0], profile.id]
        });
        userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
        user = userRes.rows[0];
      } else if (!user.google_id) {
        await db.execute({
          sql: 'UPDATE users SET google_id = ?, name = COALESCE(NULLIF(name,""), ?) WHERE email = ?',
          args: [profile.id, profile.displayName, email]
        });
        userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
        user = userRes.rows[0];
      }

      if (!user.active) return done(null, false, { message: 'Your account has been disabled.' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}
