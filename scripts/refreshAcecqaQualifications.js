// Refreshes acecqa_approved_qualifications from a real ACECQA export CSV —
// the local snapshot checkQualification (documentCheckerService.js) cross-
// checks a candidate's OCR-extracted training-package code against.
//
// This is a TWO-STEP process, not something this script can do alone —
// confirmed 2026-09-10 that ACECQA's site (acecqa.gov.au/qualifications/
// nqf-approved) sits behind Cloudflare's JS challenge, so no plain
// server-side request (this script included) can reach it directly. Only
// a real browser gets past the challenge.
//
// Step 1 (needs a real browser — ask Claude to do this via the Browser
// pane, or do it yourself):
//   1. Open https://www.acecqa.gov.au/qualifications/nqf-approved
//   2. Leave every filter blank (an unfiltered search = the full list)
//   3. Click "Export your search" — this triggers a real (if slightly
//      slow, async) export job on ACECQA's own server.
//   4. The export lands on a page titled "Exporting data..." with a
//      "Status message: Export complete. Download the file here if file
//      is not automatically downloaded." Find the actual .csv URL it
//      generated — it looks like:
//      https://www.acecqa.gov.au/sites/default/files/views_data_export/
//        qualification_data_export_1/<some-number>/qualification-export.csv
//      (visible in the browser's network log for that page load — this
//      exact static-file URL, unlike the search/export ROUTE itself, is
//      NOT behind Cloudflare's challenge and fetches fine from a plain
//      server-side request once you have it.)
//   5. Download that CSV to disk somewhere.
//
// Step 2 (this script):
//   node scripts/refreshAcecqaQualifications.js /path/to/qualification-export.csv
//
// Safe to re-run: fully replaces the table's contents each time (not
// additive), and logs the refresh to acecqa_sync_log so the Document
// Checker can show how stale the snapshot is.
require('dotenv').config();
const fs = require('fs');
const { getDb } = require('../db/database');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/refreshAcecqaQualifications.js /path/to/qualification-export.csv');
  process.exit(1);
}

// Minimal, correct RFC4180 CSV parser (handles quoted fields, embedded
// commas, embedded newlines within a quoted field — ACECQA's own
// "Important_Information" column regularly has these — and "" escaped
// quotes). No new dependency added for what's an occasional, manually-
// triggered refresh, not a hot code path.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

(async () => {
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(csvText);
  const dataRows = rows.slice(1); // drop the header row
  if (!dataRows.length) throw new Error('Parsed 0 data rows — is this really the ACECQA export CSV?');

  const db = getDb();
  await db.execute('DELETE FROM acecqa_approved_qualifications');

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < dataRows.length; i += BATCH) {
    const batch = dataRows.slice(i, i + BATCH);
    const placeholders = [];
    const values = [];
    batch.forEach((r, idx) => {
      const base = idx * 8;
      placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
      values.push(r[0] || null, r[1] || null, r[2] || null, r[3] || null, r[4] || null, r[5] || null, r[6] || null, r[7] || null);
    });
    await db.execute({
      sql: `INSERT INTO acecqa_approved_qualifications
            (qualification_level, awarding_institution, qualification_name, qualification_code, date_awarded, where_approved, awarding_institution_country, important_information)
            VALUES ${placeholders.join(',')}`,
      args: values
    });
    inserted += batch.length;
  }

  await db.execute({ sql: 'INSERT INTO acecqa_sync_log (row_count) VALUES ($1)', args: [inserted] });
  console.log(`Refreshed acecqa_approved_qualifications: ${inserted} rows imported from ${csvPath}.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
