// Matches a task title's free text (e.g. "Kirandeep Kaur | +61481309600")
// against real RT candidates (educators) and RT clients (centres) — lets
// Tasks auto-link the person/centre a task is actually about, live as the
// title is typed, before the task is even saved.
//
// Phone is the primary signal (same reasoning as centreMatchService.js's
// "Likely exists" rule, 2026-08-22: a phone match is close to unique,
// name alone isn't). Candidates come from the local rt_candidates_cache
// sync table (cheap SQL); clients come from a live RT fetch, kept in a
// short in-memory cache here since routes/centres.js's own cache is
// gated behind requireRole('admin','super_admin','workforce_partner') and
// Tasks is open to every role.

const { getDb } = require('../db/database');
const rtApi = require('./rtApiReportService');

// AU numbers only need their last 9 digits compared — that's the part
// that's actually unique once the leading '0' (domestic) or '61'
// (international) trunk/country prefix is stripped, so "0455534510",
// "+61455534510" and "455534510" all normalise to the same value.
function normalizePhoneDigits(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('61')) return digits.slice(2);
  if (digits.length === 10 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

// Pulls the first phone-shaped substring out of free text. Deliberately
// loose (matches a run of ~9-10 digits with optional +61/0 prefix and
// spaces/dashes/dots between groups) since task titles are handwritten,
// not a form field.
const PHONE_PATTERN = /(?:\+?61[ .-]?|0)4?\d(?:[ .-]?\d){7,8}/;
function extractPhone(text) {
  const match = (text || '').match(PHONE_PATTERN);
  return match ? match[0] : null;
}

// Whatever's left after removing the phone number and cutting at the
// first separator that usually starts the rest of a title ("Name | note",
// "Name - WWCC check", "Name: ...") — a best-effort name guess, not a
// strict parse.
function extractNameGuess(text, phoneMatch) {
  let rest = text || '';
  if (phoneMatch) rest = rest.replace(phoneMatch, ' ');
  rest = rest.split(/[|\-–—:]/)[0];
  return rest.replace(/[^A-Za-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function candidateResult(row, confidence) {
  return {
    userId: row.userId,
    name: [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || 'Unnamed candidate',
    phone: row.contactNo,
    email: row.email,
    confidence,
    portalUrl: `https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${row.userId}`
  };
}

async function matchCandidatesByPhone(phoneDigits) {
  if (!phoneDigits) return [];
  const res = await getDb().execute({
    sql: `SELECT user_id AS "userId", first_name AS "firstName", last_name AS "lastName", contact_no AS "contactNo", email
          FROM rt_candidates_cache
          WHERE RIGHT(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) = ? AND LENGTH(?) = 9
          LIMIT 10`,
    args: [phoneDigits, phoneDigits]
  });
  return res.rows.map(r => candidateResult(r, 'phone'));
}

async function matchCandidatesByName(nameGuess) {
  if (!nameGuess || nameGuess.length < 3) return [];
  const res = await getDb().execute({
    sql: `SELECT user_id AS "userId", first_name AS "firstName", last_name AS "lastName", contact_no AS "contactNo", email,
                 similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ?) AS sim
          FROM rt_candidates_cache
          WHERE similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ?) > 0.35
          ORDER BY sim DESC LIMIT 5`,
    args: [nameGuess, nameGuess]
  });
  return res.rows.map(r => candidateResult(r, 'name'));
}

// Short-lived, module-local cache — deliberately separate from routes/
// centres.js's own client cache (that one lives behind a role gate this
// feature isn't allowed to require).
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
let clientCache = { clients: null, expiresAt: 0 };
async function getClients() {
  if (clientCache.clients && Date.now() < clientCache.expiresAt) return clientCache.clients;
  if (!rtApi.isConfigured || !rtApi.isConfigured()) return [];
  const clients = await rtApi.fetchAllPages('clients', {});
  clientCache = { clients, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS };
  return clients;
}

function clientResult(client, location, confidence) {
  return {
    clientId: client.clientId,
    locationId: location ? location.clientsLocationId : null,
    name: client.name || client.nickName || 'Unnamed centre',
    suburb: location ? location.suburb : null,
    state: location ? location.state : null,
    phone: (location && location.contactNo) || client.landLineNo || client.contactNo || null,
    confidence
    // No portalUrl here on purpose — RT's backoffice client-profile URL
    // pattern hasn't been confirmed (only the candidate one was given), so
    // this is shown as informational match text, not a clickable link.
  };
}

async function matchClientsByPhone(phoneDigits) {
  if (!phoneDigits) return [];
  const clients = await getClients();
  const matches = [];
  for (const client of clients || []) {
    for (const location of client.locations || []) {
      const locPhone = normalizePhoneDigits(location.contactNo || client.landLineNo || client.contactNo);
      if (locPhone && locPhone === phoneDigits) matches.push(clientResult(client, location, 'phone'));
    }
  }
  return matches.slice(0, 10);
}

function nameTokens(s) { return new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean)); }
function nameOverlaps(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.size || !tb.size) return false;
  let overlap = 0;
  for (const t of tb) if (ta.has(t)) overlap++;
  return overlap >= Math.min(2, tb.size);
}

async function matchClientsByName(nameGuess) {
  if (!nameGuess || nameGuess.length < 3) return [];
  const clients = await getClients();
  const matches = [];
  for (const client of clients || []) {
    if (!nameOverlaps(nameGuess, client.name) && !nameOverlaps(nameGuess, client.nickName)) continue;
    const locations = client.locations && client.locations.length ? client.locations.slice(0, 1) : [null];
    for (const location of locations) matches.push(clientResult(client, location, 'name'));
    if (matches.length >= 5) break;
  }
  return matches.slice(0, 5);
}

// Single entry point — tries phone first (confident, can auto-select),
// falls back to fuzzy name matching (a "did you mean" list) only when no
// phone match was found, for both candidates and clients independently.
async function matchPersonOrCentre(text) {
  const phoneMatch = extractPhone(text);
  const phoneDigits = phoneMatch ? normalizePhoneDigits(phoneMatch) : null;
  const nameGuess = extractNameGuess(text, phoneMatch);

  let candidates = phoneDigits ? await matchCandidatesByPhone(phoneDigits) : [];
  if (!candidates.length) candidates = await matchCandidatesByName(nameGuess);

  let clients = phoneDigits ? await matchClientsByPhone(phoneDigits) : [];
  if (!clients.length) clients = await matchClientsByName(nameGuess);

  return {
    phoneDigits,
    nameGuess,
    candidates,
    candidateDuplicates: candidates.filter(c => c.confidence === 'phone').length > 1,
    clients,
    clientDuplicates: clients.filter(c => c.confidence === 'phone').length > 1
  };
}

module.exports = { matchPersonOrCentre, normalizePhoneDigits, extractPhone, extractNameGuess };
