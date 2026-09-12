// Refreshes acecqa_approved_qualifications from ACECQA's real, live NQF
// approved-qualifications list — the local snapshot checkQualification
// (documentCheckerService.js) cross-checks a candidate's OCR-extracted
// training-package code against.
//
// Fully automated as of 2026-09-12 (services/acecqaSyncService.js) — no
// human needs to open a browser or hunt for a download link anymore. Run
// with no arguments to do a real live sync:
//
//   node scripts/refreshAcecqaQualifications.js
//
// The manual path (a CSV you already downloaded yourself) still works as a
// fallback, in case ACECQA's page layout ever changes enough to break the
// automated flow before someone gets a chance to fix it:
//
//   node scripts/refreshAcecqaQualifications.js /path/to/qualification-export.csv
//
// Same production Sync Now button (Document Checker admin page) and the
// same weekly schedule (server.js) both call acecqaSyncService.syncFromAcecqaLive()
// directly — this script is a thin CLI wrapper around the exact same
// service, kept for local/manual runs and as a documented escape hatch.
require('dotenv').config();
const fs = require('fs');
const acecqaSync = require('../services/acecqaSyncService');

(async () => {
  const csvPath = process.argv[2];
  if (csvPath) {
    console.log(`Manual fallback path — refreshing from local file: ${csvPath}`);
    const csvText = fs.readFileSync(csvPath, 'utf8');
    const rowCount = await acecqaSync.refreshFromCsvText(csvText);
    console.log(`Refreshed acecqa_approved_qualifications: ${rowCount} rows imported from ${csvPath}.`);
    return;
  }

  console.log('Running a live automated ACECQA sync (Playwright)…');
  const { rowCount, durationMs, csvUrl } = await acecqaSync.syncFromAcecqaLive(`cli:${require('os').userInfo().username}`);
  console.log(`Refreshed acecqa_approved_qualifications: ${rowCount} rows in ${Math.round(durationMs / 1000)}s.`);
  console.log(`(Source: ${csvUrl})`);
})().catch(e => { console.error('ACECQA refresh failed:', e.message); process.exit(1); });
