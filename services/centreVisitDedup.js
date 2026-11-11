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
// First-booking-free offers count as a visit (Joy, 11 Nov 2026), but only when the
// person logged no call or visit at that centre from 14 days before to 3 days after
// the offer (offers are often logged a day before the visit itself is).
const FBF_WINDOW = "(v.visit_date AT TIME ZONE 'Australia/Melbourne')::date BETWEEN (o.offered_at AT TIME ZONE 'Australia/Melbourne')::date - 14 AND (o.offered_at AT TIME ZONE 'Australia/Melbourne')::date + 3";
const FBF_CENTRE_VISITS = `(SELECT o.centre_key, 'visit'::text AS channel, o.offered_by_email::text AS created_by_email, o.offered_by_name AS created_by_name, o.offered_at AS visit_date
  FROM first_booking_free_offers o WHERE o.lead_id IS NULL AND o.centre_key IS NOT NULL AND o.offered_by_email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM centre_visits v WHERE v.centre_key = o.centre_key AND v.status = 'completed'
    AND lower(v.created_by_email::text) = lower(o.offered_by_email::text) AND ${FBF_WINDOW}))`;
// Every centre call/visit WFP Performance counts: logged ones (deduped) plus offers above.
const COUNTED_CENTRE_ACTIVITY = `(SELECT centre_key, channel, created_by_email::text AS created_by_email, created_by_name, visit_date FROM ${COMPLETED_VISITS_DEDUPED}
  UNION ALL SELECT * FROM ${FBF_CENTRE_VISITS} fbf) cca`;
module.exports = { COMPLETED_VISITS_DEDUPED, FBF_CENTRE_VISITS, COUNTED_CENTRE_ACTIVITY, dedupeVisitRows };
