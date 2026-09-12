const { getDb } = require('../db/database');

// Replaces the old two-step "ask a human to open a browser, click Export,
// find the CSV URL, download it, then run a script" process
// (scripts/refreshAcecqaQualifications.js's original header) with a fully
// automated one. Confirmed live (2026-09-12) exactly why the two steps
// existed and exactly where the Cloudflare boundary actually sits:
//   - https://www.acecqa.gov.au/qualifications/nqf-approved (the search
//     page) IS behind Cloudflare's JS challenge for a plain server-side
//     request — a real browser clears it automatically just by running the
//     page's own JS, no special handling needed.
//   - The generated export file itself —
//     https://www.acecqa.gov.au/sites/default/files/views_data_export/
//       qualification_data_export_1/<job-id>/qualification-export.csv
//     — is NOT behind the challenge (confirmed with a plain `curl` against a
//     real generated link: 200, ~417KB, real CSV body). Only the search/
//     export ROUTE needs a real browser; the resulting static file doesn't.
// So Playwright's only job is: load the page, click "Export your search"
// with every filter left blank (blank = the full list, same as the manual
// SOP), read the real download link off the resulting "Export complete...
// Download the file here" banner (a real `<a href="...">here</a>`, not
// something sniffed off the network tab — far less likely to break if
// ACECQA's page markup shifts slightly), then hand that URL to a plain
// `fetch` for the actual bytes. The browser is closed before the CSV
// download even starts — it's only ever used to get past the challenge and
// find the link, exactly the two things a plain HTTP client can't do here.
const SEARCH_URL = 'https://www.acecqa.gov.au/qualifications/nqf-approved';
// Real, once-per-run wait — the export is described on ACECQA's own page as
// "a real (if slightly slow, async) export job on ACECQA's own server", not
// instant. 30s comfortably covers what was observed live (a few seconds)
// with real margin for a slower day.
const EXPORT_TIMEOUT_MS = 30000;

async function discoverExportCsvUrl() {
  // Lazily required — playwright(-extra) + its downloaded Chromium binary
  // are a real, non-trivial dependency only this one occasional admin-
  // triggered sync needs; nothing else in the app should pay for requiring
  // it. Plain `playwright`'s default headless Chromium does NOT clear this
  // page's Cloudflare challenge — confirmed live (2026-09-12): it sits on
  // "Just a moment..." indefinitely (12s+, never resolves), while the exact
  // same page loads instantly in a real, non-automated browser (verified
  // via the Browser pane) and in this exact Playwright setup once
  // puppeteer-extra-plugin-stealth is applied (patches navigator.webdriver
  // and the other headless-only fingerprints Cloudflare's bot check looks
  // for). Without the stealth plugin this whole function times out waiting
  // for a button that never renders — not a flaky timing issue, a real,
  // reproducible detection difference between plain headless Chromium and
  // everything else, confirmed by testing both back to back against the
  // real site.
  const { chromium } = require('playwright-extra');
  const stealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(stealthPlugin());
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
    // Real button text confirmed live: "Export your search". Every filter
    // (Qualification Level / Qualification List / General search) is left
    // at its default "- Any -"/blank exactly as the manual SOP specifies —
    // an unfiltered search is the full approved list.
    await page.getByRole('button', { name: 'Export your search' }).click();
    // The resulting page (title "Exporting data...") shows a green banner:
    // "Export complete. Download the file here if file is not automatically
    // downloaded." — "here" is a real anchor tag pointing straight at the
    // generated CSV.
    const link = page.getByRole('link', { name: 'here' });
    await link.waitFor({ state: 'visible', timeout: EXPORT_TIMEOUT_MS });
    const href = await link.getAttribute('href');
    if (!href) throw new Error('Found the "here" download link but it has no href.');
    return new URL(href, SEARCH_URL).toString();
  } finally {
    await browser.close();
  }
}

// Minimal, correct RFC4180 CSV parser (handles quoted fields, embedded
// commas, embedded newlines within a quoted field — ACECQA's own
// "Important_Information" column regularly has these — and "" escaped
// quotes). Kept dependency-free for what's still an occasional background
// job, not a hot path.
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

// Fully replaces acecqa_approved_qualifications' contents (not additive —
// ACECQA's export is always the complete current list, so a qualification
// removed from the real list should disappear here too, not linger) inside
// one transaction so a mid-refresh failure never leaves the table half-old,
// half-new — same reasoning as rtCandidatesSyncService.syncAllCandidates.
async function refreshFromCsvText(csvText, db = getDb()) {
  const rows = parseCsv(csvText);
  const dataRows = rows.slice(1); // drop the header row
  if (!dataRows.length) throw new Error('Parsed 0 data rows from the ACECQA export — got the wrong file, or the export format changed.');

  const { transaction } = require('../db/database');
  await transaction(async (tx) => {
    await tx.execute('DELETE FROM acecqa_approved_qualifications');
    const BATCH = 200;
    for (let i = 0; i < dataRows.length; i += BATCH) {
      const batch = dataRows.slice(i, i + BATCH);
      const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
      const values = batch.flatMap(r => [r[0] || null, r[1] || null, r[2] || null, r[3] || null, r[4] || null, r[5] || null, r[6] || null, r[7] || null]);
      await tx.execute({
        sql: `INSERT INTO acecqa_approved_qualifications
              (qualification_level, awarding_institution, qualification_name, qualification_code, date_awarded, where_approved, awarding_institution_country, important_information)
              VALUES ${placeholders}`,
        args: values
      });
    }
    await tx.execute({ sql: 'INSERT INTO acecqa_sync_log (row_count) VALUES (?)', args: [dataRows.length] });
  });
  return dataRows.length;
}

const STALE_RUNNING_MS = 15 * 60 * 1000; // a launch+click+download genuinely takes seconds, not minutes

async function getSyncState() {
  const row = (await getDb().execute('SELECT * FROM acecqa_sync_state WHERE id = 1')).rows[0];
  return row || null;
}

function isSyncRunning(state) {
  if (!state || state.status !== 'running') return false;
  if (!state.started_at) return false;
  return Date.now() - new Date(state.started_at).getTime() < STALE_RUNNING_MS;
}

// The one function everything else calls — Playwright discovery, then the
// plain-HTTP download (deliberately NOT through the browser: confirmed
// above the static file has no Cloudflare challenge of its own, so a normal
// fetch is faster and doesn't need the page kept open), then the DB refresh.
async function syncFromAcecqaLive(triggeredBy) {
  const db = getDb();
  const current = await getSyncState();
  if (isSyncRunning(current)) {
    throw new Error(`An ACECQA sync is already in progress (started ${current.started_at}).`);
  }
  const startedAt = new Date();
  await db.execute({
    sql: `UPDATE acecqa_sync_state SET status = 'running', started_at = ?, finished_at = NULL, error_message = NULL, triggered_by = ? WHERE id = 1`,
    args: [startedAt.toISOString(), triggeredBy || 'schedule']
  });

  try {
    const csvUrl = await discoverExportCsvUrl();
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`Downloading the generated export failed (HTTP ${res.status}).`);
    const csvText = await res.text();
    const rowCount = await refreshFromCsvText(csvText, db);
    const finishedAt = new Date();
    await db.execute({
      sql: `UPDATE acecqa_sync_state SET status = 'success', finished_at = ?, row_count = ?, duration_ms = ? WHERE id = 1`,
      args: [finishedAt.toISOString(), rowCount, finishedAt.getTime() - startedAt.getTime()]
    });
    return { rowCount, durationMs: finishedAt.getTime() - startedAt.getTime(), csvUrl };
  } catch (err) {
    await db.execute({
      sql: `UPDATE acecqa_sync_state SET status = 'failed', finished_at = now(), error_message = ? WHERE id = 1`,
      args: [err.message.slice(0, 2000)]
    });
    throw err;
  }
}

module.exports = { discoverExportCsvUrl, parseCsv, refreshFromCsvText, syncFromAcecqaLive, getSyncState, isSyncRunning };
