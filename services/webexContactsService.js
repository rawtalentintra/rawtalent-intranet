// Webex caller ID sync (Joy, 25 Nov 2026): pushes every RT educator, RT centre
// contact and JobAdder candidate into Webex *organisation contacts*, so when
// one of them calls, the Webex app shows who it is instead of a bare number.
//
// - Joy-only (super_admin): status/sync at /auth/webex-contacts/*. Uses the
//   existing RawTalent-WF service app token (see accessToken below).
// - Runs once a day (server.js) plus "Sync now".
// - Only touches contacts it created itself (companyName starts with TAG), so
//   anything added by hand in Webex is never changed or removed.
// - One contact per phone number. If a number is both an educator and a
//   JobAdder candidate, the educator wins (Educator > Centre > JobAdder).
const { getDb } = require('../db/database');

const API = 'https://webexapis.com/v1';
const TAG = 'RawTalent';
const SCHEMA = 'urn:cisco:codev:identity:contact:core:1.0';

// Uses HeartBeat's existing Webex service app (RawTalent-WF). identity:contacts_read +
// identity:contacts_rw were added to it on developer.webex.com (25 Nov 2026); a Webex
// admin has to re-authorise the app in Control Hub before the token carries them.
async function accessToken() {
  return require('./webexService').getAccessToken();
}

async function wx(token, method, path, body) {
  const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 429) { await new Promise(r => setTimeout(r, (Number(res.headers.get('retry-after')) || 5) * 1000)); return wx(token, method, path, body); }
  const text = await res.text();
  if (!res.ok) throw new Error(`Webex ${method} ${path.split('?')[0]} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Australian numbers (mobile or landline) to +61…; anything else is skipped.
function e164(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return /^\+61[2-478]\d{8}$/.test(d) ? d : null;
  if (d.startsWith('61') && d.length === 11) d = d.slice(2);
  d = d.replace(/^0/, '');
  return /^[2-478]\d{8}$/.test(d) ? '+61' + d : null;
}
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

// Everyone who should be in Webex, keyed by phone.
async function desiredContacts() {
  const want = new Map();
  const add = (phone, c) => { const p = e164(phone); if (p && !want.has(p)) want.set(p, { ...c, phone: p }); };

  // 1. RT educators (every active candidate, incl. onboarding; not Do Not Use / Not Interested).
  const eds = (await getDb().execute({ sql: `SELECT first_name, last_name, contact_no FROM rt_candidates_cache
      WHERE is_active = true AND is_deleted IS NOT TRUE AND status NOT IN (4, 8) AND coalesce(contact_no,'') <> ''`, args: [] })).rows;
  for (const r of eds) add(r.contact_no, { first: clean(r.first_name), last: clean(r.last_name), kind: 'Educator' });

  // 2. RT centres: the centre/location contact numbers.
  const { centres } = await require('../routes/centres').getCentresAndBookings();
  for (const c of centres.filter(c => c.isActive !== false)) {
    for (const ph of [c.contactNo, ...(c.allPhones || [])]) add(ph, { first: clean(c.name), last: '', kind: 'Centre', company: c.contactName ? clean(c.contactName) : '' });
  }

  // 3. JobAdder candidates (if JobAdder is connected).
  let jobAdder = 'not connected';
  try {
    const tok = await require('./jobAdderService').getValidAccessToken();
    if (tok) {
      let offset = 0, n = 0;
      for (let page = 0; page < 300; page++) {
        const res = await fetch(`${tok.apiBaseUrl}/candidates?${new URLSearchParams({ Limit: '100', Offset: String(offset) })}`, { headers: { Authorization: `Bearer ${tok.accessToken}` } });
        if (!res.ok) throw new Error(`JobAdder ${res.status}`);
        const d = await res.json(); const items = d.items || [];
        for (const c of items) { for (const ph of [c.mobile, c.phone, c.contact?.mobile, c.contact?.phone]) add(ph, { first: clean(c.firstName), last: clean(c.lastName), kind: 'JobAdder' }); n++; }
        if (items.length < 100) break; offset += 100;
      }
      jobAdder = `${n} candidates read`;
    }
  } catch (e) { jobAdder = 'error: ' + e.message; }
  return { want, jobAdder };
}

// Same style as the contacts already saved in Webex (plain name, phone as "Work" in +61 format);
// the type (Educator / Centre / JobAdder) goes in the company field instead.
const displayName = c => c.kind === 'Centre' ? c.first : ([c.first, c.last].filter(Boolean).join(' ') || 'Unknown');
const body = c => ({ schemas: SCHEMA, displayName: displayName(c), firstName: c.first || displayName(c), lastName: c.last || c.kind,
  companyName: `${TAG} ${c.kind}${c.company ? ' · ' + c.company : ''}`, phoneNumbers: [{ type: 'work', value: c.phone }], source: 'CH' });

const saveResult = out => getDb().execute({ sql: `INSERT INTO webex_contacts_auth (id, last_sync_at, last_sync_result) VALUES (1, now(), ?)
  ON CONFLICT (id) DO UPDATE SET last_sync_at = now(), last_sync_result = excluded.last_sync_result`, args: [JSON.stringify(out)] });

let running = null;
async function sync({ dryRun = false } = {}) {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const token = await accessToken();
    if (!token) throw new Error('HeartBeat\'s Webex connection is not set up.');
    const me = await wx(token, 'GET', '/people/me');
    const org = me.orgId;
    const { want, jobAdder } = await desiredContacts();

    // What's in Webex now (ours only).
    const have = new Map();
    for (let start = 0; start < 100000; start += 1000) {
      const d = await wx(token, 'GET', `/contacts/organizations/${org}/contacts/search?source=CH&limit=1000&start=${start}`);
      const items = d.result || d.items || [];
      for (const c of items) {
        if (!String(c.companyName || '').startsWith(TAG)) continue;
        const p = e164((c.phoneNumbers || [])[0]?.value);
        if (p) have.set(p, c);
      }
      if (items.length < 1000) break;
    }

    const create = [], update = [], remove = [];
    for (const [p, c] of want) {
      const h = have.get(p);
      if (!h) create.push(c);
      else if (h.displayName !== displayName(c) || h.companyName !== body(c).companyName) update.push({ id: h.contactId || h.id, c });
    }
    for (const [p, h] of have) if (!want.has(p)) remove.push(h.contactId || h.id);

    const out = { wanted: want.size, inWebex: have.size, toCreate: create.length, toUpdate: update.length, toRemove: remove.length, jobAdder, dryRun };
    if (!dryRun) {
      for (let i = 0; i < create.length; i += 500) {
        await wx(token, 'POST', `/contacts/organizations/${org}/contacts/bulk`, { schemas: SCHEMA, contacts: create.slice(i, i + 500).map(body) });
      }
      for (const u of update) await wx(token, 'PATCH', `/contacts/organizations/${org}/contacts/${u.id}`, body(u.c));
      for (let i = 0; i < remove.length; i += 500) {
        await wx(token, 'POST', `/contacts/organizations/${org}/contacts/bulk/delete`, { schemas: SCHEMA, objectIds: remove.slice(i, i + 500) });
      }
    }
    out.seconds = Math.round((Date.now() - started) / 1000);
    await saveResult(out);
    return out;
  })();
  try { return await running; } catch (e) {
    await saveResult({ error: e.message }).catch(() => {});
    throw e;
  } finally { running = null; }
}

async function status() {
  const s = (await getDb().execute('SELECT last_sync_at, last_sync_result FROM webex_contacts_auth WHERE id = 1')).rows[0];
  return { connected: !!(await accessToken().catch(() => null)), last_sync_at: s?.last_sync_at || null, last_sync_result: s?.last_sync_result ? JSON.parse(s.last_sync_result) : null };
}

module.exports = { sync, status };
