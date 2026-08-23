// Best-effort matching of a signed leads row to its real RT client/location
// record. RT has no field connecting a booking/client back to "the lead
// that created this centre" — this has to be inferred after the fact from
// phone/email/name/suburb/state, same token-overlap-and-digits-comparison
// style as documentCheckerService.js's namesLikelyMatch and the leads
// duplicate-checker's similarity() (routes/leads.js /check-duplicate).
// Only phone and email are treated as confident/"Likely exists" signals
// (confirmed 2026-08-22) — name/suburb/state are supporting context only.
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

// Scores one lead against one (client, location) pair. Phone and email are
// the only signals strong/unique enough to call a match "confident" —
// confirmed 2026-08-22: "Likely exists should either be if the email
// address or phone number matches what we already have in the system."
// Name/suburb/state are still scored as supporting signals (so a
// low-confidence "did you mean" style hint can still surface), but no
// combination of them alone reaches "confident" anymore — a shared
// suburb plus a generic name like "Children's Centre" isn't the same
// kind of signal as a real phone or email match, and treating it as
// equivalent produced real false positives (verified live). Returns null
// if nothing lines up at all, so callers can filter out true non-matches
// before ranking.
function scoreCandidate(lead, client, location) {
  const reasons = [];
  let score = 0;

  const leadPhone = digitsOnly(lead.centre_phone);
  const locPhone = digitsOnly(location.contactNo || client.landLineNo || client.contactNo);
  if (leadPhone.length >= 6 && leadPhone === locPhone) {
    score += 3;
    reasons.push('Phone number matches');
  }

  // contact_email is the decision-maker's own email, filled in once a
  // Workforce Partner has actually spoken to the centre (leads has no
  // separate "centre email" field) — compared against RT's client-level
  // email, which is typically that same contact's address on file there.
  const leadEmail = normalize(lead.contact_email);
  const clientEmail = normalize(client.email || client.emailAddress);
  if (leadEmail && clientEmail && leadEmail === clientEmail) {
    score += 3;
    reasons.push('Email matches');
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
  const emailMatched = reasons.includes('Email matches');
  // Auto-link only on a real, unique identifier — phone or email — never
  // on name/suburb/state alone or in combination, per the confirmed
  // decision above.
  const confident = phoneMatched || emailMatched;

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
