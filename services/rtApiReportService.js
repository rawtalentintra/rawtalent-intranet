// Wraps the external "RtApiReport" API (Clients/Candidates/Bookings/
// Timesheets) — a locally-built staging service with no public docs; this
// module's shape comes from reading its Swagger UI directly. Auth is a
// static X-API-Key header (RT_API_KEY), not OAuth.

const ENDPOINTS = {
  clients: { path: '/api/Reports/clients', orderParam: 'OrderByCreatedDateAscending' },
  candidates: { path: '/api/Reports/candidates', orderParam: 'OrderByCreatedDateAscending' },
  bookings: { path: '/api/Reports/getbookings', orderParam: 'OrderByBookingDateAscending' },
  timesheets: { path: '/api/Reports/timesheets', orderParam: 'OrderByCreatedDateAscending' }
};

const PAGE_SIZE = 100;
// Hard ceiling on pages fetched per request — a sane safety net against an
// unexpectedly huge or misbehaving upstream, not a real expected limit
// (at PAGE_SIZE 100 this is 50,000 records).
const MAX_PAGES = 500;
// How many pages to fetch in parallel once we know how many pages exist —
// fetching all of them one-at-a-time would be painfully slow for report
// types with more than a page or two of data.
const CONCURRENCY = 8;

function isConfigured() {
  return !!(process.env.RT_API_BASE_URL && process.env.RT_API_KEY);
}

// Retry only ever helps with a genuinely transient 502 — a malformed
// request or bad API key would be a 4xx, never worth retrying. Added
// 2026-09-19 while investigating why every full candidates sync had
// started failing outright (candidate payloads got much bigger around
// this date — RT started returning gender, profilePhoto, banHistory,
// ratings, and several other new fields per candidate). In practice, for
// THIS bug retry never actually rescued anything — confirmed the exact
// same set of ~80 pages fails every time, identically, whether fetched at
// full concurrency or one at a time with no concurrency at all — it's RT's
// backend failing to serialize a specific block of older candidates
// (created 2023-06-08 to 2025-01-09, confirmed by bisecting the page
// range), not a transient blip retry could ever fix. Kept anyway as sound
// defensive practice for genuine transient network issues on any of the
// four report types this module serves — see fetchAllPages'
// tolerateFailures comment for how the persistent kind is actually
// handled, once retries here are exhausted.
const RETRYABLE_STATUS_MIN = 500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchPage(reportType, pageNumber, filters) {
  const { path, orderParam } = ENDPOINTS[reportType];
  const params = new URLSearchParams({
    PageNumber: String(pageNumber),
    PageSize: String(PAGE_SIZE),
    [orderParam]: String(filters.orderAscending !== false)
  });
  if (filters.startDate) params.set('StartDate', filters.startDate);
  if (filters.endDate) params.set('EndDate', filters.endDate);
  if (filters.isActive !== undefined) params.set('IsActive', String(filters.isActive));

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    const res = await fetch(`${process.env.RT_API_BASE_URL}${path}?${params}`, {
      headers: { 'X-API-Key': process.env.RT_API_KEY }
    });
    if (res.ok) {
      const json = await res.json();
      if (!json.isSuccess) throw new Error(`RT API ${reportType} error: ${json.message || 'unknown error'}`);
      return json.data; // { items, totalCount, pageNumber, pageSize }
    }
    const body = await res.text().catch(() => '');
    lastErr = new Error(`RT API ${reportType} request failed (${res.status}): ${body.slice(0, 300)}`);
    if (res.status < RETRYABLE_STATUS_MIN) throw lastErr; // a 4xx will never succeed on retry
  }
  throw lastErr; // exhausted retries on a persistent 5xx
}

// Fetches every page for a report type and returns one flat array —
// mirrors how the rest of this app's dashboards (e.g. Sales/Leads) fetch
// a full dataset once and compute everything else client-side.
async function fetchAllPages(reportType, filters = {}, options = {}) {
  if (!isConfigured()) throw new Error('RT Reports API is not configured — set RT_API_BASE_URL and RT_API_KEY');
  if (!ENDPOINTS[reportType]) throw new Error(`Unknown RT API report type: ${reportType}`);

  const first = await fetchPage(reportType, 1, filters);
  const items = [...(first.items || [])];
  const pageSize = first.pageSize || PAGE_SIZE;
  const totalPages = Math.min(Math.max(1, Math.ceil((first.totalCount || items.length) / pageSize)), MAX_PAGES);

  const remaining = [];
  for (let p = 2; p <= totalPages; p++) remaining.push(p);

  // `tolerateFailures` (2026-09-19, added for the candidates sync): ~80 of
  // ~250 candidate pages fail with a 502 every single time, retries
  // included — confirmed reproducible (the exact same page numbers,
  // independently, across several separate runs, identical whether fetched
  // at full concurrency or fully sequentially one at a time), so this
  // isn't transient load on either side. It's RT's backend failing to
  // serialize a specific block of older candidates — bisected the page
  // range to createdDate 2023-06-08 through 2025-01-09 (~8,200 candidates,
  // roughly userId 6582-16915) — right around when candidate payloads got
  // much richer (gender, profilePhoto, banHistory, ratings, and several
  // other new fields), so something about how those particular older
  // records carry (or don't carry) that new data appears to crash RT's own
  // serializer. A real bug on RT's side, reported to them with this exact
  // range — nothing on our end can make their backend return these pages
  // correctly. Skip a page that's still failing after every retry rather
  // than aborting the whole fetch, but tell the caller which pages/rows
  // are missing so it can decide whether it's safe to treat this as a full
  // dataset (syncAllCandidates uses this to skip its stale-row cleanup on
  // a partial fetch — see its own comment).
  const failedPages = [];
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async p => {
      try { return await fetchPage(reportType, p, filters); }
      catch (err) {
        if (!options.tolerateFailures) throw err;
        failedPages.push(p);
        console.error(`RT API ${reportType} page ${p} failed persistently, skipping: ${err.message}`);
        return { items: [] };
      }
    }));
    results.forEach(r => items.push(...(r.items || [])));
  }
  return options.tolerateFailures ? { items, failedPages } : items;
}

async function fetchById(reportType, id) {
  if (!isConfigured()) throw new Error('RT Reports API is not configured — set RT_API_BASE_URL and RT_API_KEY');
  const byIdPaths = {
    clients: `/api/Reports/getclientbyid/${id}`,
    candidates: `/api/Reports/getcandidatebyid/${id}`,
    bookings: `/api/Reports/getbookingbyid/${id}`,
    timesheets: `/api/Reports/gettimesheetbybookingid/${id}`
  };
  const path = byIdPaths[reportType];
  if (!path) throw new Error(`Unknown RT API report type: ${reportType}`);

  const res = await fetch(`${process.env.RT_API_BASE_URL}${path}`, {
    headers: { 'X-API-Key': process.env.RT_API_KEY }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RT API ${reportType} by-id request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.isSuccess) throw new Error(`RT API ${reportType} error: ${json.message || 'unknown error'}`);
  return json.data;
}

module.exports = { isConfigured, fetchAllPages, fetchById };
