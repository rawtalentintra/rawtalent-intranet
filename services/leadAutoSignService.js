// Auto-detects when a pending lead has actually been converted — a
// Workforce Partner creates the real client profile directly in RT (this
// app has no "create RT client" action of its own), so the only sign a
// lead genuinely signed is a matching RT client record appearing after
// the fact. Previously this only ever got caught by someone remembering
// to open the lead and flip Profile Created to "signed" by hand.
//
// Reuses the exact same confidence-gated match (centreMatchService) the
// Leads list's "Existing Centre?" badge already shows — the only new
// piece is the timing check that tells a fresh conversion apart from a
// lead that just happens to match a centre RT already had on file.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const rtApi = require('./rtApiReportService');
const centreMatchService = require('./centreMatchService');

// Clock/timezone slop between our created_at and RT's own createdDate
// isn't a real signal either way — this just keeps a few hours of drift
// from being misread as "predates the lead". The real test is coarse:
// did the RT centre show up meaningfully after this lead was submitted
// (a fresh conversion) or meaningfully before (a pre-existing centre this
// lead happens to match — stays a "Likely exists" warning, never
// auto-signed, since that's the actual duplicate-risk case this whole
// match system exists to flag).
const PREDATE_GRACE_MS = 24 * 60 * 60 * 1000;

async function checkAndAutoSignLeads() {
  const db = getDb();
  const pending = (await db.execute("SELECT * FROM leads WHERE signed_status = 'pending' AND closed_at IS NULL")).rows;
  if (!pending.length) return { checked: 0, signed: 0 };

  const clients = await rtApi.fetchAllPages('clients', {});
  let signedCount = 0;

  for (const lead of pending) {
    const match = centreMatchService.findConfidentMatch(lead, clients);
    if (!match || !match.createdDate) continue;

    const rtCreatedMs = new Date(match.createdDate).getTime();
    const leadCreatedMs = new Date(lead.created_at).getTime();
    if (Number.isNaN(rtCreatedMs) || rtCreatedMs < leadCreatedMs - PREDATE_GRACE_MS) continue;

    const signedAtIso = new Date(rtCreatedMs).toISOString();
    await db.execute({
      sql: `UPDATE leads SET
              signed_status = 'signed', signed_at = ?,
              lead_called_status = CASE WHEN lead_called_status = 'to_schedule' THEN 'n_a' ELSE lead_called_status END,
              centre_visited_status = CASE WHEN centre_visited_status = 'to_schedule' THEN 'n_a' ELSE centre_visited_status END,
              closed_at = COALESCE(closed_at, ?), closed_by_email = COALESCE(closed_by_email, ?),
              updated_at = now()
            WHERE id = ?`,
      args: [signedAtIso, signedAtIso, 'system-auto-detect@rawtalent.com.au', lead.id]
    });
    // Left as a visible note (not just a silent DB flip) so whoever next
    // opens this lead sees exactly why it's showing as signed without
    // them — or anyone else — having touched it.
    await db.execute({
      sql: 'INSERT INTO lead_notes (id, lead_id, note, author_name, author_email) VALUES (?, ?, ?, ?, ?)',
      args: [
        uuidv4(), lead.id,
        `Automatically marked Profile Created — found a matching RT centre (${match.clientName}, ${match.locationLabel}) created ${new Date(match.createdDate).toLocaleDateString('en-AU')}. Matched on: ${match.reasons.join(', ')}.`,
        'HeartBeat (automatic)', 'system-auto-detect@rawtalent.com.au'
      ]
    });
    signedCount++;
  }

  return { checked: pending.length, signed: signedCount };
}

module.exports = { checkAndAutoSignLeads };
