// DoFoodSafely for OSHC (Sophia confirmed with Gwen and Justine, 26 Oct: the
// certificate is mandatory for OSHC shifts). Read-only from HeartBeat's RT copy:
// who has a "Do Food Safely" document, and "OSHC-ready" = Active in RT, fully
// compliant (educatorComplianceService) and a REVIEWED Do Food Safely
// certificate that isn't expired. Internal (staff) view only; Joy decides
// before anything is shown to educators or centres. Never writes to RT.
// Note (28 Oct): RT's feed currently omits onboarding status and visa details,
// so "fully compliant" here can't check those until RT restores them.
const { getDb } = require('../db/database');
const { complianceReasons } = require('./educatorComplianceService');
const { normalizeStateToShort } = require('./micropodService');

let cache = { at: 0, value: null };
async function list() {
  if (cache.value && Date.now() - cache.at < 30 * 60 * 1000) return cache.value;
  const rows = (await getDb().execute({
    sql: `SELECT user_id::text uid, first_name, last_name, email, contact_no, raw->'addresses'->0 addr, raw->'qualifications'->0->>'qualificationName' qual,
                 raw->'attachedRequirements' reqs, raw->'visaDetails' visa
          FROM rt_candidates_cache WHERE is_deleted IS NOT TRUE AND status = 1`, args: []
  })).rows;
  const today = new Date().toISOString().slice(0, 10);
  const people = rows.map(r => {
    const dfs = (r.reqs || []).filter(d => !d.isDeleted && d.isActive !== false && /do food safely/i.test(d.requirementName || ''))
      .sort((a, b) => String(b.expiryDate || '').localeCompare(String(a.expiryDate || '')))[0] || null;
    const exp = dfs?.expiryDate ? String(dfs.expiryDate).slice(0, 10) : null;
    const dfsValid = !!dfs && dfs.isReviewed === true && !(exp && !['0001-01-01', '9999-12-31'].includes(exp) && exp < today);
    const reasons = complianceReasons({ attachedRequirements: r.reqs, visaDetails: r.visa }, today);
    return {
      userId: r.uid, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), email: r.email, phone: r.contact_no,
      suburb: r.addr?.suburb || '', state: normalizeStateToShort(r.addr?.state) || '', qualification: r.qual || '',
      hasDfs: !!dfs, dfsReviewed: dfs?.isReviewed === true, dfsValid, compliant: !reasons.length, oshcReady: dfsValid && !reasons.length,
      gap: !dfs ? 'No Do Food Safely certificate' : !dfs.isReviewed ? 'Certificate not reviewed yet' : !dfsValid ? 'Certificate expired' : reasons.length ? reasons.join('; ') : null
    };
  });
  cache = { at: Date.now(), value: people };
  return people;
}
module.exports = { list };
