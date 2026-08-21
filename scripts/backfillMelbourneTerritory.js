// One-time backfill for Liam's Melbourne territory split (2026-08-22
// directive) — run once against production to apply the new north/west
// (Liam) vs east/south-east/bayside (Justine) suburb split to every
// existing centre and lead. Ongoing "incoming" leads are handled by
// routes/leads.js's own auto-assignment (melbourneTerritoryService),
// not this script — this only touches what already existed at the time
// the directive landed.
//
// Safe to re-run: it's idempotent (recomputes and upserts/updates every
// row to the same deterministic result each time), not additive.
//
// Usage: node scripts/backfillMelbourneTerritory.js [--dry-run]
require('dotenv').config();
const { getDb } = require('../db/database');
const rtApi = require('../services/rtApiReportService');
const { flattenCentres } = require('../services/centreKeyService');
const { partnerForSuburbState, isVicState, LIAM, JUSTINE } = require('../services/melbourneTerritoryService');

const DRY_RUN = process.argv.includes('--dry-run');
const ATTRIBUTION_EMAIL = 'liam@rawtalent.com.au';
const ATTRIBUTION_NAME = 'Melbourne territory split (2026-08-22 directive)';

async function backfillLeads(db) {
  const res = await db.execute('SELECT id, suburb, state, assigned_workforce_partner FROM leads');
  const vicLeads = res.rows.filter(l => isVicState(l.state) || l.state === 'VIC');
  let liamCount = 0, justineCount = 0, changed = 0;
  for (const lead of vicLeads) {
    const partner = partnerForSuburbState(lead.suburb, 'VIC');
    if (partner === LIAM) liamCount++; else if (partner === JUSTINE) justineCount++;
    if (partner && partner !== lead.assigned_workforce_partner) {
      changed++;
      if (!DRY_RUN) {
        await db.execute({
          sql: 'UPDATE leads SET assigned_workforce_partner = ?, updated_at = now() WHERE id = ?',
          args: [partner, lead.id]
        });
      }
    }
  }
  console.log(`Leads — VIC total: ${vicLeads.length}, Liam: ${liamCount}, Justine: ${justineCount}, rows changed: ${changed}${DRY_RUN ? ' (dry run, nothing written)' : ''}`);
}

async function backfillCentres(db) {
  const clients = await rtApi.fetchAllPages('clients', {});
  const centres = flattenCentres(clients).filter(c => c.isActive);
  const vicCentres = centres.filter(c => isVicState(c.state));
  let liamCount = 0, justineCount = 0;
  for (const centre of vicCentres) {
    const partner = partnerForSuburbState(centre.suburb, centre.state);
    if (!partner) continue;
    if (partner === LIAM) liamCount++; else justineCount++;
    if (!DRY_RUN) {
      await db.execute({
        sql: `INSERT INTO centre_partner_assignments (centre_key, workforce_partner, assigned_by_email, assigned_by_name)
              VALUES (?, ?, ?, ?)
              ON CONFLICT (centre_key) DO UPDATE SET workforce_partner = excluded.workforce_partner,
                assigned_by_email = excluded.assigned_by_email, assigned_by_name = excluded.assigned_by_name, assigned_at = now()`,
        args: [centre.centreKey, partner, ATTRIBUTION_EMAIL, ATTRIBUTION_NAME]
      });
    }
  }
  console.log(`Centres — VIC total: ${vicCentres.length}, Liam: ${liamCount}, Justine: ${justineCount}${DRY_RUN ? ' (dry run, nothing written)' : ''}`);
}

(async () => {
  const db = getDb();
  console.log(DRY_RUN ? '--- DRY RUN (no writes) ---' : '--- APPLYING BACKFILL ---');
  await backfillLeads(db);
  await backfillCentres(db);
  console.log('Done.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
