// $100 welcome bonus for QR code referrals (Liam, 13 Oct 2026 — point 2).
// When an educator marked "Eligible" on the QR Code Referrals page accepts
// their first shift with Raw Talent, create one task in the Payroll
// department so the $100 gets paid. Runs on HeartBeat's copy of RT bookings
// (refreshed through the day), so it can lag by a few hours — agreed with Joy
// 2026-10-14. Only shifts dated on or after the educator registered count.
// Reads RT data only; never writes to RT.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { getCentresAndBookings } = require('../routes/centres');

const BONUS_AMOUNT = 100;
const ACCEPTED_STATUS_IDS = new Set([3, 5]); // Assigned, Completed
const PAYROLL_ASSIGNEES = ['sophia@rawtalent.com.au'];
const digits9 = v => String(v || '').replace(/\D/g, '').slice(-9);

async function resolveRtUserId(db, r) {
  if (r.rt_user_id) return r.rt_user_id;
  if (r.email) {
    const m = (await db.execute({ sql: 'SELECT user_id::text uid FROM rt_candidates_cache WHERE lower(email) = lower(?) AND is_deleted IS NOT TRUE', args: [r.email] })).rows;
    if (m.length === 1) return m[0].uid;
  }
  const p = digits9(r.phone);
  if (p.length === 9 && !/(\d)\1{5,}/.test(p)) {
    const m = (await db.execute({ sql: "SELECT user_id::text uid FROM rt_candidates_cache WHERE right(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) = ? AND is_deleted IS NOT TRUE", args: [p] })).rows;
    if (m.length === 1) return m[0].uid;
  }
  return null;
}

async function createBonusTasks() {
  const db = getDb();
  const due = (await db.execute({ sql: 'SELECT * FROM qr_referrals WHERE bonus_eligible IS TRUE AND bonus_task_id IS NULL', args: [] })).rows;
  if (!due.length) return { created: 0 };
  const { bookings, centres } = await getCentresAndBookings();
  const nameByKey = new Map(centres.map(c => [c.centreKey, c.name]));
  let created = 0;
  for (const r of due) {
    const uid = await resolveRtUserId(db, r);
    if (!uid) continue;
    if (!r.rt_user_id) await db.execute({ sql: 'UPDATE qr_referrals SET rt_user_id = ? WHERE id = ?', args: [uid, r.id] });
    const since = new Date(r.created_at).toISOString().slice(0, 10);
    const first = bookings
      .filter(b => String(b.assignedUserId) === uid && ACCEPTED_STATUS_IDS.has(b.statusId) && (b.bookingDate || '').slice(0, 10) >= since)
      .sort((a, b) => String(a.bookingDate).localeCompare(String(b.bookingDate)))[0];
    if (!first) continue;
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
    const centre = nameByKey.get(`loc:${first.locationId}`) || nameByKey.get(`client:${first.clientId}`) || first.locationName || first.clientName || 'centre';
    const shiftDate = (first.bookingDate || '').slice(0, 10);
    const taskId = uuidv4();
    const description = [
      `Pay a $${BONUS_AMOUNT} welcome bonus to ${name}.`,
      `They registered through a QR code poster at ${r.centre_name_entered} and have accepted their first Raw Talent shift: ${centre} on ${shiftDate} (RT booking ${first.clientBookingId}).`,
      r.offered_rate != null ? `Agreed rate: $${r.offered_rate}/hr (previous agency $${r.current_agency_rate ?? '?'}/hr).` : null,
      'Created automatically from QR Code Referrals. Check the shift went ahead before paying.'
    ].filter(Boolean).join('\n\n');
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'payroll', NULL, ?, ?, 'to_do', 'normal', ?, NULL, 'system@rawtalent.internal', 'Auto — QR welcome bonus', '[]', ?, '[]')`,
      args: [taskId, `$${BONUS_AMOUNT} welcome bonus — ${name}`, description, JSON.stringify(PAYROLL_ASSIGNEES),
             JSON.stringify([{ userId: Number(uid), name, phone: r.phone || null, email: r.email || null }])]
    });
    await db.execute({ sql: 'UPDATE qr_referrals SET bonus_task_id = ?, first_shift_booking_id = ?, first_shift_date = ? WHERE id = ?', args: [taskId, String(first.clientBookingId), shiftDate, r.id] });
    created++;
  }
  return { created };
}

// ── Activation → Workforce Partner follow-up (Liam, 13 Oct, point 4) ─────
// When a QR-referred educator is Active in RT with onboarding Completed, stamp
// activated_at (so they appear in the partner's Familiar Educators list) and
// create one follow-up task for the partner who looks after the scanned centre.
async function processActivations() {
  const db = getDb();
  const rows = (await db.execute({ sql: 'SELECT * FROM qr_referrals WHERE activated_at IS NULL OR partner_task_id IS NULL', args: [] })).rows;
  if (!rows.length) return { activated: 0, tasks: 0 };
  const { centres } = await getCentresAndBookings();
  const byKey = new Map(centres.map(c => [c.centreKey, c]));
  const { getCentrePartnerAssignments } = require('../routes/centres');
  const { partnerForCentre } = require('../routes/qrReferrals');
  const assignments = await getCentrePartnerAssignments();
  const partnerEmail = new Map((await db.execute({ sql: "SELECT wfp_label, email FROM users WHERE wfp_label IS NOT NULL AND active = true", args: [] })).rows.map(u => [u.wfp_label, u.email]));
  let activated = 0, tasks = 0;
  for (const r of rows) {
    const uid = await resolveRtUserId(db, r);
    if (!uid) continue;
    if (!r.rt_user_id) await db.execute({ sql: 'UPDATE qr_referrals SET rt_user_id = ? WHERE id = ?', args: [uid, r.id] });
    const c = (await db.execute({ sql: "SELECT status, raw->>'obStatus' ob, raw->>'statusUpdateDate' since, raw->'qualifications'->0->>'qualificationName' qual FROM rt_candidates_cache WHERE user_id = ?", args: [uid] })).rows[0];
    if (!c || c.status !== 1 || c.ob !== 'Completed') continue;
    let activatedAt = r.activated_at;
    if (!activatedAt) {
      const since = c.since && !String(c.since).startsWith('0001') && new Date(c.since) >= new Date(r.created_at) ? c.since : new Date().toISOString();
      await db.execute({ sql: 'UPDATE qr_referrals SET activated_at = ?, status = CASE WHEN status IN (\'new\',\'contacted\',\'onboarding\') THEN \'active\' ELSE status END WHERE id = ?', args: [since, r.id] });
      activatedAt = since; activated++;
    }
    if (r.partner_task_id) continue;
    const centre = byKey.get(r.centre_key);
    const partner = partnerForCentre(centre, assignments);
    const email = partner && partnerEmail.get(partner);
    if (!centre || !email) continue; // no matched centre or no partner login to assign to yet
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
    const taskId = uuidv4();
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'workforce_partners', NULL, ?, ?, 'to_do', 'normal', ?, NULL, 'system@rawtalent.internal', 'Auto — QR familiar educator', '[]', ?, ?)`,
      args: [taskId, `New Familiar Educator Available – ${centre.name}`,
        `${name}${c.qual ? ' (' + c.qual + ')' : ''} has completed onboarding and is now active with Raw Talent. They joined through the recruitment poster at ${centre.name}.\n\nPlease contact the centre to advise that the educator is available through Raw Talent and help them add the educator to their favourites or request them for future bookings.`,
        JSON.stringify([email.toLowerCase()]),
        JSON.stringify([{ userId: Number(uid), name, phone: r.phone || null, email: r.email || null }]),
        JSON.stringify([{ centreKey: centre.centreKey, name: centre.name }])]
    });
    await db.execute({ sql: 'UPDATE qr_referrals SET partner_task_id = ? WHERE id = ?', args: [taskId, r.id] });
    tasks++;
  }
  return { activated, tasks };
}

module.exports = { createBonusTasks, processActivations, BONUS_AMOUNT };
