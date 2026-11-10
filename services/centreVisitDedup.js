// Completed centre calls/visits, counted once per centre + person + channel +
// Melbourne day (11 Nov 2026). A one-tap Quick log followed by the full form
// used to leave two completed rows for one real visit; rows are kept, the
// counts just collapse them, preferring the full entry over the Quick log.
const DAY = "(visit_date AT TIME ZONE 'Australia/Melbourne')::date";
const COMPLETED_VISITS_DEDUPED = `(SELECT DISTINCT ON (centre_key, lower(created_by_email), channel, ${DAY}) *
  FROM centre_visits WHERE status = 'completed'
  ORDER BY centre_key, lower(created_by_email), channel, ${DAY}, (activity_type = 'Quick log'), created_at) cvd`;
function dedupeVisitRows(rows, keyOf = r => r.centre_key) {
  const day = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
  const best = new Map();
  for (const r of rows) {
    const k = [keyOf(r), String(r.created_by_email || '').toLowerCase(), r.channel || 'visit', day(r.visit_date)].join('|');
    const cur = best.get(k);
    const rank = x => (x.activity_type === 'Quick log' ? 1 : 0);
    if (!cur || rank(r) < rank(cur)) best.set(k, r);
  }
  return [...best.values()];
}
module.exports = { COMPLETED_VISITS_DEDUPED, dedupeVisitRows };
