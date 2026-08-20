// Best-effort matching of a signed leads row to its real RT client/location
// record. RT has no field connecting a booking/client back to "the lead
// that created this centre" — this has to be inferred after the fact from
// name/phone/suburb/state, same token-overlap-and-digits-comparison style
// as documentCheckerService.js's namesLikelyMatch and the leads
// duplicate-checker's similarity() (routes/leads.js /check-duplicate).
//
// A centre in `leads` is one physical address; an RT Client can have
// multiple locations[], each its own site with its own clientsLocationId —
// the real join key for booking data (Booking.locationId matches
// clientsLocationId, not the parent Client.clientId — see the RT API Data
// Reference page). So matching happens per-location, not per-client.

function digitsOnly(s) {
  return (s || '').replace(/\D/g, '');
}

function normalize(s) {
  return (s || '').toLowerCase().trim();
}

// leads.state is the short form ('VIC'/'SA'/...); RT location.state is the
// full name ('Victoria') — verified against a real client record. Normalise
// both to the short form before comparing.
const STATE_FULL_TO_SHORT = {
  victoria: 'VIC', 'new south wales': 'NSW', queensland: 'QLD',
  'south australia': 'SA', 'western australia': 'WA', tasmania: 'TAS',
  'northern territory': 'NT', 'australian capital territory': 'ACT'
};
function shortState(s) {
  const n = normalize(s);
  if (!n) return '';
  return STATE_FULL_TO_SHORT[n] || n.toUpperCase();
}

function nameTokens(s) {
  return new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
}

function nameOverlaps(a, b) {
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (!tokensA.size || !tokensB.size) return false;
  let overlap = 0;
  for (const t of tokensB) if (tokensA.has(t)) overlap++;
  return overlap >= Math.min(2, tokensB.size);
}

// Scores one lead against one (client, location) pair. Phone match is the
// strongest signal (a centre's landline rarely coincides by chance);
// name/suburb/state are supporting signals. Returns null if nothing lines
// up at all, so callers can filter out true non-matches before ranking.
function scoreCandidate(lead, client, location) {
  const reasons = [];
  let score = 0;

  const leadPhone = digitsOnly(lead.centre_phone);
  const locPhone = digitsOnly(location.contactNo || client.landLineNo || client.contactNo);
  if (leadPhone.length >= 6 && leadPhone === locPhone) {
    score += 3;
    reasons.push('Phone number matches');
  }

  if (nameOverlaps(lead.centre_name, client.name) || nameOverlaps(lead.centre_name, client.nickName)) {
    score += 2;
    reasons.push('Centre name matches');
  }

  if (lead.suburb && location.suburb && normalize(lead.suburb) === normalize(location.suburb)) {
    score += 1;
    reasons.push('Suburb matches');
  }

  if (lead.state && location.state && shortState(lead.state) === shortState(location.state)) {
    score += 1;
    reasons.push('State matches');
  }

  if (!score) return null;

  const phoneMatched = reasons.includes('Phone number matches');
  const nameMatched = reasons.includes('Centre name matches');
  const suburbMatched = reasons.includes('Suburb matches');
  // Auto-link only when there's one strong signal plus a supporting one —
  // a single matching field (just a suburb, or just a common name like
  // "Little Learners") isn't confident enough to silently attach booking
  // data to the wrong centre.
  const confident = phoneMatched || (nameMatched && suburbMatched);

  return {
    rtClientId: client.clientId,
    rtLocationId: location.clientsLocationId,
    clientName: client.name || client.nickName || 'Unnamed client',
    locationLabel: [location.suburb, location.state].filter(Boolean).join(', ') || 'No address on file',
    // Locations don't carry their own creation date in RT's API (verified
    // against real data) — only the parent Client does. Used by
    // leadAutoSignService to tell "this RT centre was created because this
    // lead just converted" (client.createdDate after the lead's own
    // created_at) apart from "this lead just happens to match a
    // pre-existing centre" (createdDate predates the lead) — the latter
    // stays a manual "Likely exists" warning, never auto-signed.
    createdDate: client.createdDate || null,
    score,
    confident,
    reasons
  };
}

// Returns every candidate match for one lead, sorted best-first, across
// every client/location RT knows about. `clients` is the flat array from
// rtApiReportService.fetchAllPages('clients', {}) — each with a
// `locations` array.
function findMatches(lead, clients) {
  const candidates = [];
  for (const client of clients || []) {
    for (const location of client.locations || []) {
      const candidate = scoreCandidate(lead, client, location);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

// The single best match, only if it clears the auto-link confidence bar —
// used for lazy background linking. Anything less confident is left for
// the manual "Link this centre" picker (findMatches) instead.
function findConfidentMatch(lead, clients) {
  const matches = findMatches(lead, clients);
  return matches.length && matches[0].confident ? matches[0] : null;
}

module.exports = { findMatches, findConfidentMatch, scoreCandidate, shortState };
