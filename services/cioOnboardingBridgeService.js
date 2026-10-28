// Customer.io onboarding bridge (Joy approved 29 Oct: "it's fine because RT
// feeds that data directly to customer.io"). RT's slimmed candidate feed has no
// obStatus since 27 Oct, so HeartBeat reads Customer.io's onboarding_complete
// (plus profile_status / vetting_complete) for Active educators, READ-ONLY via
// the App API (CUSTOMERIO_APP_API_KEY), nightly after the RT sync. Profiles are
// keyed by the RT person/user id. Stored in cio_educator_status.
// onboardingCompleted() prefers RT's own obStatus whenever RT sends it, so the
// bridge switches itself off automatically when RT restores the field.
// visa_tab_status is stored as an informational hint only — never a visa pass.
const { getDb } = require('../db/database');

const LABEL = 'Onboarding status from Customer.io (may lag RT by up to a day)';
const truthy = v => v === true || v === 1 || /^(true|yes|1|completed?)$/i.test(String(v ?? '').trim());

async function fetchAttributes(id, key) {
  const r = await fetch(`https://api.customer.io/v1/customers/${encodeURIComponent(id)}/attributes`, { headers: { Authorization: `Bearer ${key}` } });
  if (r.status === 404) return null;
  if (r.status === 429) { await new Promise(res => setTimeout(res, 2000)); return fetchAttributes(id, key); }
  if (!r.ok) throw new Error(`Customer.io ${r.status}`);
  const d = await r.json();
  return d?.customer?.attributes || {};
}

// Nightly: read the Active educators' Customer.io status (only when RT's own
// obStatus is missing). ~2k profiles at a polite pace.
async function sync({ concurrency = 4 } = {}) {
  const key = process.env.CUSTOMERIO_APP_API_KEY;
  if (!key) return { skipped: 'CUSTOMERIO_APP_API_KEY not set' };
  const db = getDb();
  const rtHas = (await db.execute({ sql: "SELECT count(*) FILTER (WHERE jsonb_exists(raw, 'obStatus')) n FROM rt_candidates_cache WHERE status = 1 AND is_deleted IS NOT TRUE", args: [] })).rows[0];
  if (Number(rtHas.n) > 0) return { skipped: 'RT is sending obStatus again; bridge not needed' };
  const ids = (await db.execute({ sql: 'SELECT user_id::text uid FROM rt_candidates_cache WHERE status = 1 AND is_deleted IS NOT TRUE', args: [] })).rows.map(r => r.uid);
  let i = 0, ok = 0, missing = 0, failed = 0;
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        const a = await fetchAttributes(id, key);
        if (!a) { missing++; continue; }
        await db.execute({
          sql: `INSERT INTO cio_educator_status (user_id, onboarding_complete, profile_status, vetting_complete, visa_tab_status, synced_at) VALUES (?,?,?,?,?, now())
                ON CONFLICT (user_id) DO UPDATE SET onboarding_complete = excluded.onboarding_complete, profile_status = excluded.profile_status,
                  vetting_complete = excluded.vetting_complete, visa_tab_status = excluded.visa_tab_status, synced_at = now()`,
          args: [id, a.onboarding_complete == null ? null : truthy(a.onboarding_complete), a.profile_status != null ? String(a.profile_status) : null,
            a.vetting_complete == null ? null : truthy(a.vetting_complete), a.visa_tab_status != null ? String(a.visa_tab_status) : null]
        });
        ok++;
      } catch { failed++; }
      await new Promise(res => setTimeout(res, 120));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`Customer.io onboarding bridge: ${ok} read, ${missing} no profile, ${failed} failed (of ${ids.length}).`);
  return { read: ok, noProfile: missing, failed, total: ids.length };
}

// Map of RT user id → onboarding Completed?, from Customer.io (bridge rows only).
let mapCache = { at: 0, value: null };
async function bridgeMap() {
  if (mapCache.value && Date.now() - mapCache.at < 10 * 60 * 1000) return mapCache.value;
  const rows = (await getDb().execute({ sql: 'SELECT user_id, onboarding_complete FROM cio_educator_status', args: [] }).catch(() => ({ rows: [] }))).rows;
  mapCache = { at: Date.now(), value: new Map(rows.map(r => [String(r.user_id), r.onboarding_complete === true])) };
  return mapCache.value;
}

// The one onboarding check: RT's obStatus when RT sends it, otherwise Customer.io.
function onboardingCompleted(uid, rtObStatus, map) {
  if (rtObStatus !== undefined && rtObStatus !== null) return /complete/i.test(String(rtObStatus));
  return !!(map && map.get(String(uid)));
}
async function bridgeActive() {
  const m = await bridgeMap();
  return m.size > 0;
}

module.exports = { LABEL, sync, bridgeMap, onboardingCompleted, bridgeActive };
