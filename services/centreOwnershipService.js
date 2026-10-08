// WFP centre ownership rules from the 14 and 17 Sep 2026 attribution-model
// meetings (Liam/Joy/Sophia) — the parts that sit on top of the existing
// centre_partner_assignments table (a row = a partner owns the centre; no row
// = RawTalent owns it; see also centreReactivationService.js for the
// reactivation rule). Two rules live here:
//
//  1. NETWORK EXPANSION — "if a WP converts one centre in a network, all other
//     centres in that network subsequently converted by the WP also belong to
//     them." A network is one RT client with more than one location (e.g.
//     Edge Early Learning is a single RT client with 70+ locations). RT dates
//     a client, not each location, so "subsequently converted" is judged by a
//     location's FIRST booking: a sibling whose first-ever booking comes after
//     the partner's ownership of another centre in that network began counts
//     as newly converted. Only ever fills a centre that has no owner; never
//     overrides an existing row.
//
//  2. TERRITORY HANDOFF — when a new partner is hired for a state, the new
//     partner starts at zero, the original partner keeps 50% of the centres
//     they own there, and the other 50% revert to RawTalent. The meetings did
//     NOT say which half is kept, so this only PROPOSES (ranked by recent
//     booking volume, suggestion only) and applies exactly the keep-list a
//     person supplies.
//
// Network anchors only count ownership recorded on/after OWNERSHIP_MODEL_START.
// The 256 rows that existed before it are the bulk Liam/Justine territory split
// from the superseded 22 Aug model — they say where a centre sits, not that a
// partner converted a network.

const { getDb } = require('../db/database');
const { getCentresAndBookings, indexBookingsByCentre, bookingsForCentre } = require('../routes/centres');
const { MEANINGFUL_BOOKING_STATUSES } = require('./centreHealthService');

const OWNERSHIP_MODEL_START = '2026-09-17T00:00:00Z';
const PARTNER_LABELS = ['Justine', 'Gwen'];
const RAWTALENT_LABEL = 'RawTalent';
const SYSTEM_ASSIGNER_EMAIL = 'system@rawtalent.internal';
const NETWORK_ASSIGNER_NAME = 'Auto — Network expansion';
const BOOKING_WINDOW_DAYS = 366; // same window the reactivation rule reads

function stateBucket(raw) {
  const s = (raw || '').trim().toLowerCase();
  const map = { victoria: 'VIC', vic: 'VIC', 'south australia': 'SA', sa: 'SA', queensland: 'QLD', qld: 'QLD',
    'northern territory': 'NT', nt: 'NT', 'australian capital territory': 'ACT', act: 'ACT', 'western australia': 'WA', wa: 'WA' };
  return map[s] || null;
}

// Pure: centres = flattenCentres() rows; assignments = centre_partner_assignments
// rows { centre_key, workforce_partner, assigned_at }; firstBookingAt(centre) =
// ISO date of the centre's first meaningful booking in the window, or null.
function findNetworkExpansionCredits(centres, assignments, firstBookingAt, { modelStart = OWNERSHIP_MODEL_START } = {}) {
  const ownerByKey = new Map(assignments.map(a => [a.centre_key, a]));
  const byClient = new Map();
  for (const c of centres) { if (!byClient.has(c.rtClientId)) byClient.set(c.rtClientId, []); byClient.get(c.rtClientId).push(c); }

  const credits = [], conflicts = [];
  const startMs = new Date(modelStart).getTime();
  for (const [clientId, members] of byClient) {
    if (members.length < 2) continue; // not a network
    // Earliest qualifying ownership per partner in this network.
    const anchors = new Map();
    for (const c of members) {
      const a = ownerByKey.get(c.centreKey);
      if (!a || !PARTNER_LABELS.includes(a.workforce_partner)) continue;
      const at = new Date(a.assigned_at).getTime();
      if (isNaN(at) || at < startMs) continue;
      const cur = anchors.get(a.workforce_partner);
      if (!cur || at < cur.at) anchors.set(a.workforce_partner, { at, centreKey: c.centreKey, centreName: c.name });
    }
    if (!anchors.size) continue;
    const networkName = members[0].name;
    if (anchors.size > 1) {
      // Two partners both converted a centre here — the rule doesn't say who
      // gets the rest, so don't guess.
      conflicts.push({ rtClientId: clientId, networkName, partners: [...anchors.keys()] });
      continue;
    }
    const [partner, anchor] = [...anchors.entries()][0];
    for (const c of members) {
      if (ownerByKey.has(c.centreKey) || c.isActive === false) continue;
      const first = firstBookingAt(c);
      if (!first || new Date(first).getTime() <= anchor.at) continue;
      credits.push({ centreKey: c.centreKey, name: c.name, partner, rtClientId: clientId, networkName,
        anchorCentreKey: anchor.centreKey, anchorCentreName: anchor.centreName, anchorAt: new Date(anchor.at).toISOString(), firstBookingAt: first });
    }
  }
  return { credits, conflicts };
}

async function loadInputs() {
  const [{ centres, bookings }, asg] = await Promise.all([
    getCentresAndBookings(),
    getDb().execute({ sql: 'SELECT centre_key, workforce_partner, assigned_at FROM centre_partner_assignments', args: [] })
  ]);
  const index = indexBookingsByCentre(bookings);
  const windowStart = Date.now() - BOOKING_WINDOW_DAYS * 86400000;
  const firstBookingAt = centre => {
    const dates = bookingsForCentre(index, centre)
      .filter(b => MEANINGFUL_BOOKING_STATUSES.has(b.statusId) && b.bookingDate && new Date(b.bookingDate).getTime() >= windowStart)
      .map(b => b.bookingDate).sort();
    return dates[0] || null;
  };
  return { centres, assignments: asg.rows, firstBookingAt, index };
}

async function previewNetworkExpansion() {
  const { centres, assignments, firstBookingAt } = await loadInputs();
  return findNetworkExpansionCredits(centres, assignments, firstBookingAt);
}

async function applyNetworkExpansion() {
  const { credits, conflicts } = await previewNetworkExpansion();
  let applied = 0;
  for (const c of credits) {
    const r = await getDb().execute({
      sql: `INSERT INTO centre_partner_assignments (centre_key, workforce_partner, assigned_by_email, assigned_by_name)
            VALUES (?, ?, ?, ?) ON CONFLICT (centre_key) DO NOTHING`,
      args: [c.centreKey, c.partner, SYSTEM_ASSIGNER_EMAIL, NETWORK_ASSIGNER_NAME]
    });
    if (r.rowsAffected) applied++;
  }
  return { credits, conflicts, applied };
}

// Territory handoff — PROPOSAL ONLY. Lists the partner's centres in the state
// with recent booking volume; `suggestedKeep` is simply the busier half and is
// a suggestion, not a rule (the meetings didn't define which 50% is kept).
async function proposeTerritoryHandoff({ state, fromPartner }) {
  const wanted = stateBucket(state);
  if (!wanted) throw new Error('Unknown state');
  const { centres, assignments, index } = await loadInputs();
  const owned = new Set(assignments.filter(a => a.workforce_partner === fromPartner).map(a => a.centre_key));
  const cutoff = Date.now() - 180 * 86400000;
  const rows = centres.filter(c => owned.has(c.centreKey) && stateBucket(c.state) === wanted).map(c => ({
    centreKey: c.centreKey, name: c.name, suburb: c.suburb,
    bookings180d: bookingsForCentre(index, c).filter(b => MEANINGFUL_BOOKING_STATUSES.has(b.statusId) && new Date(b.bookingDate).getTime() >= cutoff).length
  })).sort((a, b) => b.bookings180d - a.bookings180d || a.name.localeCompare(b.name));
  const keepCount = Math.ceil(rows.length / 2);
  return { state: wanted, fromPartner, total: rows.length, keepCount, centres: rows, suggestedKeep: rows.slice(0, keepCount).map(r => r.centreKey) };
}

// Applies exactly what a person decided: every centre `fromPartner` owns in the
// state that is NOT in keepCentreKeys reverts to RawTalent. The new partner is
// not given anything (they start at zero).
async function applyTerritoryHandoff({ state, fromPartner, keepCentreKeys, actorEmail, actorName }) {
  if (!Array.isArray(keepCentreKeys)) throw new Error('keepCentreKeys (an explicit list, may be empty) is required');
  const proposal = await proposeTerritoryHandoff({ state, fromPartner });
  const keep = new Set(keepCentreKeys);
  const unknown = keepCentreKeys.filter(k => !proposal.centres.some(c => c.centreKey === k));
  if (unknown.length) throw new Error(`Not owned by ${fromPartner} in ${proposal.state}: ${unknown.join(', ')}`);
  const reverting = proposal.centres.filter(c => !keep.has(c.centreKey));
  for (const c of reverting) {
    await getDb().execute({
      sql: `UPDATE centre_partner_assignments SET workforce_partner = ?, assigned_by_email = ?, assigned_by_name = ?, assigned_at = now()
            WHERE centre_key = ? AND workforce_partner = ?`,
      args: [RAWTALENT_LABEL, actorEmail, `${actorName || actorEmail} — territory handoff (${proposal.state})`, c.centreKey, fromPartner]
    });
  }
  return { state: proposal.state, fromPartner, kept: proposal.total - reverting.length, revertedToRawTalent: reverting.length, reverted: reverting.map(c => c.name) };
}

module.exports = {
  findNetworkExpansionCredits, previewNetworkExpansion, applyNetworkExpansion,
  proposeTerritoryHandoff, applyTerritoryHandoff, OWNERSHIP_MODEL_START, PARTNER_LABELS
};
