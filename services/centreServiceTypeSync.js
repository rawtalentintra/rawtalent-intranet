// Centre service type → Customer.io Centre object (9 Nov 2026).
// RT's Reports API only gives serviceTypeId on bookings (0 = ECEC/long day
// care, 1 = OSHC), not on the client, so HeartBeat works the centre's type
// out itself and writes service_type_id onto the Customer.io Centre object
// (object_type_id 1, object_id = RT location id). Journey 1/2 (#33/#36,
// #39/#44) split ECEC vs OSHC on it.
//   Sources, combined: the HeartBeat lead linked to that RT location
//   (leads.service_type: early_childhood / oshc / both), the centre's own
//   category (centre_categories), and the last 12 months of RT bookings.
//   Only OSHC seen → 1, only ECEC → 0, both → 2. Nothing known → not sent.
// Sends only changes (centre_service_type_sync keeps the last value sent).
// Behind the same FBF_CIO_ENABLED switch as the other Customer.io signals.
// Reads RT only; never writes to RT.
const { getDb } = require('../db/database');
const fbf = require('./firstBookingFreeService');

const FROM_TEXT = { early_childhood: [0], oshc: [1], both: [0, 1] };

function idFromSet(set) {
  if (set.has(0) && set.has(1)) return 2;
  if (set.has(1)) return 1;
  if (set.has(0)) return 0;
  return null;
}

// Map of RT location id → { service_type_id, sources }.
async function computeServiceTypes() {
  const db = getDb();
  const { centres, bookings } = await require('../routes/centres').getCentresAndBookings();
  const seen = new Map(); // locationId → { set, sources }
  const add = (loc, ids, source) => {
    if (loc == null) return;
    const k = String(loc);
    let e = seen.get(k);
    if (!e) { e = { set: new Set(), sources: new Set() }; seen.set(k, e); }
    for (const id of ids) e.set.add(id);
    e.sources.add(source);
  };
  for (const b of bookings || []) {
    const st = Number(b.serviceTypeId);
    if (b.locationId != null && (st === 0 || st === 1)) add(b.locationId, [st], 'bookings');
    // A booking only ever carries 0 or 1; a 2 here would mean RT sent the
    // centre's own value, which already says Both.
    else if (b.locationId != null && st === 2) add(b.locationId, [0, 1], 'bookings');
  }
  const leads = (await db.execute({ sql: "SELECT rt_location_id, service_type FROM leads WHERE rt_location_id IS NOT NULL AND service_type IS NOT NULL", args: [] })).rows;
  for (const l of leads) {
    const ids = FROM_TEXT[String(l.service_type).trim().toLowerCase()];
    if (ids) add(l.rt_location_id, ids, 'lead');
  }
  const cats = (await db.execute({ sql: "SELECT centre_key, service_type FROM centre_categories WHERE centre_key LIKE 'loc:%' AND service_type IS NOT NULL", args: [] })).rows;
  for (const c of cats) {
    const ids = FROM_TEXT[String(c.service_type).trim().toLowerCase()];
    if (ids) add(c.centre_key.slice(4), ids, 'category');
  }
  const active = new Set((centres || []).filter(c => c.rtLocationId != null).map(c => String(c.rtLocationId)));
  const out = new Map();
  for (const [loc, e] of seen) {
    if (!active.has(loc)) continue;
    const id = idFromSet(e.set);
    if (id != null) out.set(loc, { service_type_id: id, sources: [...e.sources].sort().join('+') });
  }
  return out;
}

async function sendCentreObject(locationId, attributes) {
  const cfg = fbf.cioTrackConfig();
  const auth = 'Basic ' + Buffer.from(`${cfg.siteId}:${cfg.key}`).toString('base64');
  const r = await fetch(`${cfg.host}/api/v2/entity`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'object', identifiers: { object_type_id: '1', object_id: String(locationId) }, action: 'identify', attributes })
  });
  if (!r.ok) throw new Error(`Customer.io centre ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function syncCentreServiceTypes({ dryRun = false } = {}) {
  const db = getDb();
  const types = await computeServiceTypes();
  const last = new Map((await db.execute({ sql: 'SELECT rt_location_id, sent_service_type_id FROM centre_service_type_sync WHERE sent_service_type_id IS NOT NULL', args: [] })).rows
    .map(r => [String(r.rt_location_id), Number(r.sent_service_type_id)]));
  const changed = [...types].filter(([loc, t]) => last.get(loc) !== t.service_type_id);
  const counts = { total: types.size, ecec: 0, oshc: 0, both: 0, changed: changed.length, sent: 0, failed: 0 };
  for (const t of types.values()) counts[['ecec', 'oshc', 'both'][t.service_type_id]]++;
  if (dryRun || !fbf.cioTrackConfig().ready) return { ...counts, skipped: dryRun ? 'dry run' : 'Customer.io switched off', types };
  for (const [loc, t] of changed) {
    let err = null;
    try { await sendCentreObject(loc, { service_type_id: t.service_type_id }); counts.sent++; } catch (e) { err = String(e.message).slice(0, 300); counts.failed++; }
    await db.execute({
      sql: `INSERT INTO centre_service_type_sync (rt_location_id, service_type_id, sources, sent_service_type_id, sent_at, error, updated_at)
            VALUES (?, ?, ?, ?, ${err ? 'NULL' : 'now()'}, ?, now())
            ON CONFLICT (rt_location_id) DO UPDATE SET service_type_id = EXCLUDED.service_type_id, sources = EXCLUDED.sources,
              sent_service_type_id = COALESCE(EXCLUDED.sent_service_type_id, centre_service_type_sync.sent_service_type_id),
              sent_at = COALESCE(EXCLUDED.sent_at, centre_service_type_sync.sent_at), error = EXCLUDED.error, updated_at = now()`,
      args: [Number(loc), t.service_type_id, t.sources, err ? null : t.service_type_id, err]
    });
  }
  return counts;
}

module.exports = { computeServiceTypes, syncCentreServiceTypes, idFromSet };
