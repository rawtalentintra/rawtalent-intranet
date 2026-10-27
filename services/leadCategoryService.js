// Lead service type + group category (Liam, 26 Oct 2026). Consultants look the
// group up online after the call, so "unknown" is allowed until it's set. When
// a lead matches an RT centre, the same category is copied to
// centre_categories so the centre shows it too.
const { getDb } = require('../db/database');

const SERVICE_TYPES = { early_childhood: 'Early Childhood', oshc: 'OSHC' };
const GROUPS = {
  early_childhood: {
    big: 'Big group (e.g. Goodstart, Guardian, G8)', medium: 'Medium group', small: 'Small group',
    independent: 'Independent / Private', community: 'Community-based / Co-op', council: 'Council', unknown: 'Unknown (look it up)'
  },
  oshc: { big: 'Big group', medium: 'Medium group', independent: 'Independent', unknown: 'Unknown (look it up)' }
};
const SHORT = { big: 'Big group', medium: 'Medium group', small: 'Small group', independent: 'Independent', community: 'Community / Co-op', council: 'Council', unknown: 'Unknown' };

function validate(serviceType, groupCategory) {
  const st = serviceType || null, gc = groupCategory || null;
  if (st && !SERVICE_TYPES[st]) throw Object.assign(new Error('Service type must be Early Childhood or OSHC'), { status: 400 });
  if (gc && !st) throw Object.assign(new Error('Pick the service type first'), { status: 400 });
  if (gc && !GROUPS[st][gc]) throw Object.assign(new Error(`That group isn't an option for ${SERVICE_TYPES[st]}`), { status: 400 });
  return { st, gc };
}

async function setLeadCategory(leadId, { serviceType, groupCategory }, user) {
  const db = getDb();
  const { st, gc } = validate(serviceType, groupCategory);
  const lead = (await db.execute({ sql: 'SELECT id, centre_name, centre_phone, contact_email, suburb, state FROM leads WHERE id = ?', args: [leadId] })).rows[0];
  if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
  await db.execute({
    sql: 'UPDATE leads SET service_type = ?, group_category = ?, category_set_by = ?, category_set_at = now(), updated_at = now() WHERE id = ?',
    args: [st, gc || (st ? 'unknown' : null), user.email, leadId]
  });
  // Copy to the matched RT centre, if any (RT down → just skip; the lead is saved).
  try {
    const { getCentresAndBookings } = require('../routes/centres');
    const { rawClients } = await getCentresAndBookings();
    const m = require('./centreMatchService').findConfidentMatch(lead, rawClients);
    if (m && st) {
      const key = m.rtLocationId ? `loc:${m.rtLocationId}` : `client:${m.rtClientId}`;
      await db.execute({
        sql: `INSERT INTO centre_categories (centre_key, service_type, group_category, source_lead_id, set_by, set_at) VALUES (?,?,?,?,?, now())
              ON CONFLICT (centre_key) DO UPDATE SET service_type = excluded.service_type, group_category = excluded.group_category, source_lead_id = excluded.source_lead_id, set_by = excluded.set_by, set_at = now()`,
        args: [key, st, gc || 'unknown', leadId, user.email]
      });
    }
  } catch { /* RT unavailable — centre copy happens next time it's saved */ }
  return (await db.execute({ sql: 'SELECT service_type, group_category, category_set_by, category_set_at FROM leads WHERE id = ?', args: [leadId] })).rows[0];
}

async function setCentreCategory(centreKey, { serviceType, groupCategory }, user) {
  const { st, gc } = validate(serviceType, groupCategory);
  await getDb().execute({
    sql: `INSERT INTO centre_categories (centre_key, service_type, group_category, set_by, set_at) VALUES (?,?,?,?, now())
          ON CONFLICT (centre_key) DO UPDATE SET service_type = excluded.service_type, group_category = excluded.group_category, set_by = excluded.set_by, set_at = now()`,
    args: [centreKey, st, gc || (st ? 'unknown' : null), user.email]
  });
  return { service_type: st, group_category: gc || (st ? 'unknown' : null) };
}

const label = (st, gc) => st ? `${SERVICE_TYPES[st]} · ${SHORT[gc || 'unknown']}` : null;

module.exports = { SERVICE_TYPES, GROUPS, SHORT, setLeadCategory, setCentreCategory, label };
