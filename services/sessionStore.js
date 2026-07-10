const session = require('express-session');
const { getDb } = require('../db/database');

// Persists express-session data in the same Supabase Postgres DB as
// everything else, so logins survive a redeploy instead of being wiped every
// time the container restarts (the default MemoryStore only lives in process
// RAM). express-session calls store.touch() on essentially every
// authenticated request (any time the session is read but not otherwise
// modified), just to push the cookie expiry forward. Persisting that to a
// remote DB every time would mean 1 extra network round trip per request for
// no practical benefit — the 7-day maxAge doesn't need per-request precision.
// Throttle actual writes to once per SID per THROTTLE_MS; anything more
// frequent is a no-op.
const TOUCH_THROTTLE_MS = 15 * 60 * 1000;

class PgSessionStore extends session.Store {
  constructor() {
    super();
    this._lastTouch = new Map(); // sid -> ms timestamp of last persisted touch
  }

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
      this._lastTouch.delete(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  // No partial-update API for sessions, so a real touch just re-saves with
  // the refreshed expiry — but throttled (see TOUCH_THROTTLE_MS above) so it
  // isn't a remote write on every single request.
  touch(sid, sessionData, callback) {
    const now = Date.now();
    const last = this._lastTouch.get(sid) || 0;
    if (now - last < TOUCH_THROTTLE_MS) return callback?.(null);
    this._lastTouch.set(sid, now);
    this.set(sid, sessionData, callback);
  }
}

module.exports = PgSessionStore;
