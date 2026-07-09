const session = require('express-session');
const { getDb } = require('../db/database');

// Persists express-session data in the same Turso DB as everything else,
// so logins survive a redeploy instead of being wiped every time the
// container restarts (the default MemoryStore only lives in process RAM).
class TursoSessionStore extends session.Store {
  async get(sid, callback) {
    try {
      const result = await getDb().execute({ sql: 'SELECT sess, expires FROM sessions WHERE sid = ?', args: [sid] });
      const row = result.rows[0];
      if (!row) return callback(null, null);
      if (row.expires && Number(row.expires) < Date.now()) {
        await getDb().execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  async set(sid, sessionData, callback) {
    try {
      const expires = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      await getDb().execute({
        sql: `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
              ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        args: [sid, JSON.stringify(sessionData), expires]
      });
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await getDb().execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  // No partial-update API for sessions, so just re-save with the refreshed expiry.
  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }
}

module.exports = TursoSessionStore;
