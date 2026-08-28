const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const TOKEN_PREFIX = 'rt_mcp_';

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// The raw token is returned exactly once, at creation — only its hash
// and a short display prefix are ever persisted. Matches this codebase's
// existing "show it once" convention for anything secret (see the
// payslip/team-invoice bank details work — same principle, different
// data).
async function generateToken(userEmail, label) {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO mcp_tokens (id, user_email, label, token_hash, token_prefix)
          VALUES (?, ?, ?, ?, ?)`,
    args: [uuidv4(), userEmail, label || null, hashToken(raw), raw.slice(0, TOKEN_PREFIX.length + 8)]
  });
  return raw;
}

async function listTokens(userEmail) {
  const res = await getDb().execute({
    sql: `SELECT id, label, token_prefix, created_at, last_used_at, revoked_at
          FROM mcp_tokens WHERE LOWER(user_email) = LOWER(?) ORDER BY created_at DESC`,
    args: [userEmail]
  });
  return res.rows;
}

async function revokeToken(id, userEmail) {
  const res = await getDb().execute({
    sql: `UPDATE mcp_tokens SET revoked_at = now() WHERE id = ? AND LOWER(user_email) = LOWER(?) AND revoked_at IS NULL`,
    args: [id, userEmail]
  });
  if (!res.rowsAffected) throw new Error('Token not found');
}

// Verifies a raw bearer token and returns the {email, role} it belongs
// to, or null if invalid/revoked. Joins users for role/active status so
// a token stops working the moment the account it belongs to is
// deactivated, without needing to separately revoke every token that
// account ever issued.
async function verifyToken(rawToken) {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT t.id, t.user_email, u.role, u.active
          FROM mcp_tokens t
          JOIN users u ON LOWER(u.email) = LOWER(t.user_email)
          WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    args: [hashToken(rawToken)]
  });
  const row = res.rows[0];
  if (!row || row.active === false) return null;
  db.execute({ sql: 'UPDATE mcp_tokens SET last_used_at = now() WHERE id = ?', args: [row.id] }).catch(() => {});
  return { email: row.user_email, role: row.role };
}

module.exports = { generateToken, listTokens, revokeToken, verifyToken };
