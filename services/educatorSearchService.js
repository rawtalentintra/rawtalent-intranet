// Shared educator/candidate search + profile lookup against
// rt_candidates_cache (RT's real candidate database, synced nightly —
// see services/rtCandidatesSyncService.js). Factored out of routes/mcp.js
// (search_educators/get_educator) so the Workforce Partner PWA's REST
// routes (routes/educators.js) and the MCP tool both call the exact same
// query instead of maintaining two copies that could drift.
const { getDb } = require('../db/database');

// Phone is the strong signal (near-unique once normalised) — same
// 9-trailing-digit comparison services/taskPersonMatchService.js uses, so
// "0417225760", "+61417225760" and "417225760" all match each other.
async function searchEducators(query, limit = 10) {
  const digits = (query || '').replace(/\D/g, '');
  const db = getDb();
  if (digits.length >= 8) {
    const res = await db.execute({
      sql: `SELECT user_id, first_name, last_name, contact_no, email, suburb, is_active, expiring_docs_count
            FROM rt_candidates_cache
            WHERE RIGHT(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) = RIGHT(?, 9)
            LIMIT ?`,
      args: [digits, limit]
    });
    return res.rows;
  }
  const res = await db.execute({
    sql: `SELECT user_id, first_name, last_name, contact_no, email, suburb, is_active, expiring_docs_count,
                 similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ?) AS sim
          FROM rt_candidates_cache
          WHERE similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ?) > 0.25 OR email ILIKE ?
          ORDER BY sim DESC NULLS LAST LIMIT ?`,
    args: [query, query, `%${query}%`, limit]
  });
  return res.rows;
}

// Full cached RT candidate row, including the `raw` JSON (addresses,
// qualifications, attachedRequirements/compliance docs) — same shape
// get_educator already reads.
async function getEducatorProfile(userId) {
  const res = await getDb().execute({ sql: `SELECT * FROM rt_candidates_cache WHERE user_id = ?`, args: [userId] });
  return res.rows[0] || null;
}

module.exports = { searchEducators, getEducatorProfile };
