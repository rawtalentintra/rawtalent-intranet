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

  const res = await fetch(`${process.env.RT_API_BASE_URL}${path}?${params}`, {
    headers: { 'X-API-Key': process.env.RT_API_KEY }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RT API ${reportType} request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.isSuccess) throw new Error(`RT API ${reportType} error: ${json.message || 'unknown error'}`);
  return json.data; // { items, totalCount, pageNumber, pageSize }
}

// Fetches every page for a report type and returns one flat array —
// mirrors how the rest of this app's dashboards (e.g. Sales/Leads) fetch
// a full dataset once and compute everything else client-side.
async function fetchAllPages(reportType, filters = {}) {
  if (!isConfigured()) throw new Error('RT Reports API is not configured — set RT_API_BASE_URL and RT_API_KEY');
  if (!ENDPOINTS[reportType]) throw new Error(`Unknown RT API report type: ${reportType}`);

  const first = await fetchPage(reportType, 1, filters);
  const items = [...(first.items || [])];
  const pageSize = first.pageSize || PAGE_SIZE;
  const totalPages = Math.min(Math.max(1, Math.ceil((first.totalCount || items.length) / pageSize)), MAX_PAGES);

  const remaining = [];
  for (let p = 2; p <= totalPages; p++) remaining.push(p);

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(p => fetchPage(reportType, p, filters)));
    results.forEach(r => items.push(...(r.items || [])));
  }
  return items;
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
