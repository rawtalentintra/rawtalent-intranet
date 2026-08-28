// OAuth 2.1 (authorization code + PKCE, Dynamic Client Registration)
// backing the MCP Custom Connector flow — see routes/mcpOAuth.js for the
// actual HTTP endpoints and db/schema.sql's mcp_oauth_clients comment for
// why this exists at all. This file owns the two pieces of OAuth state:
// registered clients (persisted — a client should keep working across a
// Railway redeploy) and short-lived authorization codes (in-memory —
// they're single-use and die in ~2 minutes, so persisting them isn't
// worth the table).
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const CODE_TTL_MS = 2 * 60 * 1000;
// code -> { clientId, redirectUri, codeChallenge, codeChallengeMethod, email, scope, expiresAt }
const authCodes = new Map();

function pruneExpiredCodes() {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
}

async function registerClient({ clientName, redirectUris }) {
  if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.some(u => typeof u !== 'string' || !u)) {
    throw new Error('redirect_uris must be a non-empty array of strings');
  }
  const clientId = randomUUID();
  await getDb().execute({
    sql: `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?::jsonb)`,
    args: [clientId, clientName || null, JSON.stringify(redirectUris)]
  });
  return { client_id: clientId, client_name: clientName || null, redirect_uris: redirectUris };
}

async function getClient(clientId) {
  const res = await getDb().execute({ sql: `SELECT client_id, client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = ?`, args: [clientId] });
  return res.rows[0] || null;
}

function issueCode({ clientId, redirectUri, codeChallenge, codeChallengeMethod, email, scope }) {
  pruneExpiredCodes();
  const code = crypto.randomBytes(32).toString('hex');
  authCodes.set(code, { clientId, redirectUri, codeChallenge, codeChallengeMethod, email, scope, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

// Single-use: consuming a code (valid or not) removes it, so a replay of
// the same code — even a still-unexpired one — always fails the second
// time, per the OAuth spec's "authorization codes MUST be single use".
function consumeCode(code) {
  pruneExpiredCodes();
  const entry = authCodes.get(code);
  if (!entry) return null;
  authCodes.delete(code);
  return entry;
}

// PKCE (RFC 7636) S256 verification — the only method this server
// advertises/accepts (see /.well-known/oauth-authorization-server).
function verifyPkce(codeVerifier, codeChallenge) {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

module.exports = { registerClient, getClient, issueCode, consumeCode, verifyPkce };
