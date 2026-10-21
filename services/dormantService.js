// Dormant centres call list (Liam, 19 Oct 2026 strategy meeting). See
// db/schema.sql's dormant_touchpoints.
//  - Dormant = the centre's last booking was 6+ months ago. HeartBeat's RT
//    booking history only goes back ~12 months, so a centre with no booking at
//    all in that window can't be told apart from one that never booked and is
//    left off the list.
//  - "Centre dormant" sits in Action Required until a partner presses
//    "Dormant touch point complete" (after a call or visit). The centre stays
//    dormant until it books again; a new touch point is only asked for if it
//    books and then goes dormant again.
//  - On complete, Customer.io gets dormant_touchpoint_complete (behind
//    FBF_CIO_ENABLED, OFF by default), which starts the Dormant journey with or
//    without First Booking Free (attribute dormant_touchpoint_fbf set first). FBF ticked here does NOT also send
//    first_booking_free_tagged, so the centre isn't emailed twice.
// Reads RT only; never writes to RT.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const fbf = require('./firstBookingFreeService');

const DORMANT_DAYS = 182;
const LIAM = 'liam@rawtalent.com.au';
const DISCOUNT_APPROVAL_FROM = 5; // $/hr — under $5 needs no approval; $5 or more goes to Liam
const CLIENT_FOLLOW_UP = '4c6ae463-b50e-43b5-934a-a81572c024e9'; // management → Client Follow up

const dayStr = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Centre status badge (Liam, 19 Oct): one simple, explainable rule on the
// centre's own bookings (shift dates, booked/assigned/completed, up to today):
//  - Dormant:   no booking for 6+ months (DORMANT_DAYS).
//  - New:       first booking we hold is within the last 8 weeks.
//  - Growing:   last 4 weeks' weekly rate is at least 25% above the prior 8 weeks' (and 2+ bookings in the last 4 weeks).
//  - Declining: last 4 weeks' weekly rate is at least 25% below the prior 8 weeks' (and 2+ bookings in the prior 8).
//  - Steady:    anything else that booked in the last 12 weeks; Quiet: no booking in 12 weeks but under 6 months.
const LIVE_STATUSES = new Set([1, 2, 3, 5]);
function computeTrend(centreBookings, now = Date.now()) {
  const DAY = 864e5;
  const ts = (centreBookings || []).filter(b => LIVE_STATUSES.has(b.statusId) && b.bookingDate)
    .map(b => new Date(b.bookingDate).getTime()).filter(t => t <= now).sort((a, b) => a - b);
  const last4 = ts.filter(t => now - t < 28 * DAY).length;
  const prior8 = ts.filter(t => now - t >= 28 * DAY && now - t < 84 * DAY).length;
  const first = ts[0] || null, last = ts[ts.length - 1] || null;
  const r4 = last4 / 4, r8 = prior8 / 8;
  let status;
  if (!last || now - last >= DORMANT_DAYS * DAY) status = last ? 'dormant' : 'none';
  else if (now - first < 56 * DAY) status = 'new';
  else if (last4 >= 2 && r4 >= r8 * 1.25) status = 'growing';
  else if (prior8 >= 2 && r4 <= r8 * 0.75) status = 'declining';
  else if (now - last >= 84 * DAY) status = 'quiet';
  else status = 'steady';
  return { status, last4Weeks: last4, prior8Weeks: prior8, firstBookingDate: first ? dayStr(first) : null, firstBookingDaysAgo: first ? Math.floor((now - first) / DAY) : null };
}

async function latestTouchpoints(keys) {
  if (!keys.length) return {};
  const rows = (await getDb().execute({
    sql: `SELECT DISTINCT ON (centre_key) * FROM dormant_touchpoints WHERE centre_key = ANY(?) ORDER BY centre_key, completed_at DESC`,
    args: [keys]
  })).rows;
  return Object.fromEntries(rows.map(r => [r.centre_key, r]));
}

// Adds dormancy fields to each centre from the centre list.
async function annotateDormancy(centres, lastBookingByKey) {
  const tps = await latestTouchpoints(centres.map(c => c.centreKey));
  const now = Date.now();
  // RT sometimes has the same centre as two locations (e.g. a duplicate
  // "Lovely Banks" with one old booking). A location only counts as dormant if
  // no location with the same name has booked in the last 6 months.
  const norm = n => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const latestByName = {};
  for (const c of centres) {
    const l = lastBookingByKey[c.centreKey]; if (!l) continue;
    const k = norm(c.name), t = new Date(l).getTime();
    if (!latestByName[k] || t > latestByName[k]) latestByName[k] = t;
  }
  return centres.map(c => {
    const last = lastBookingByKey[c.centreKey] || null;
    const days = last ? Math.floor((now - new Date(last).getTime()) / 864e5) : null;
    const sibling = latestByName[norm(c.name)];
    const isDormant = days != null && days >= DORMANT_DAYS && !(sibling && (now - sibling) / 864e5 < DORMANT_DAYS);
    const tp = tps[c.centreKey];
    const touchedSinceLastBooking = !!(tp && last && new Date(tp.completed_at) > new Date(last));
    return {
      ...c,
      lastBookingDate: dayStr(last),
      daysSinceLastBooking: days,
      isDormant,
      dormantNeedsContact: isDormant && !touchedSinceLastBooking,
      bookingTrend: c.bookingTrend ? { ...c.bookingTrend, status: isDormant ? 'dormant' : (c.bookingTrend.status === 'dormant' ? 'quiet' : c.bookingTrend.status) } : c.bookingTrend,
      lastDormantTouchpoint: tp ? { at: tp.completed_at, by: tp.completed_by_name, firstBookingFree: tp.first_booking_free } : null
    };
  });
}

async function completeTouchpoint(centre, user, body) {
  const db = getDb();
  const type = body.touchpointType === 'visit' ? 'visit' : 'call';
  const fbfOn = body.firstBookingFree === true;
  const discount = body.discountPerHour === '' || body.discountPerHour == null ? null : Number(body.discountPerHour);
  if (discount != null && (!Number.isFinite(discount) || discount < 0 || discount > 100)) throw Object.assign(new Error('Discount must be a dollar amount per hour'), { status: 400 });
  const pricing = String(body.pricingNote || '').trim().slice(0, 2000) || null;

  const row = (await db.execute({
    sql: `INSERT INTO dormant_touchpoints (centre_key, centre_name, state, partner_label, last_booking_date, touchpoint_type, first_booking_free, pricing_note, discount_per_hour, completed_by_email, completed_by_name)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [centre.centreKey, centre.name, centre.stateShort, centre.partnerLabel, centre.lastBookingDate, type, fbfOn, pricing, discount, user.email, user.name || user.email]
  })).rows[0];

  // FBF ticked: record the offer so accounts gets the "don't charge" task on the
  // first booking, but mark it as carried by the dormant event (no second email).
  if (fbfOn) {
    await db.execute({
      sql: `INSERT INTO first_booking_free_offers (centre_key, centre_name, contact_email, contact_first_name, offered_by_email, offered_by_name, state, email_status)
            VALUES (?,?,?,?,?,?,?, 'via_dormant')
            ON CONFLICT (centre_key) DO NOTHING`,
      args: [centre.centreKey, centre.name, centre.email || null, (centre.contactName || '').split(' ')[0] || null, user.email, user.name || user.email, centre.stateShort]
    });
  }

  // A discount of $5/hr or more needs Liam's approval.
  if (discount != null && discount >= DISCOUNT_APPROVAL_FROM) {
    const taskId = uuidv4();
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'management', ?, ?, ?, 'to_do', 'high', ?, NULL, ?, ?, '[]', '[]', ?)`,
      args: [taskId, CLIENT_FOLLOW_UP, `Discount approval — ${centre.name} ($${discount.toFixed(2)}/hr)`,
        `${user.name || user.email} discussed pricing with ${centre.name} during a dormant touch point and proposed a discount of $${discount.toFixed(2)}/hr.\n\n${pricing ? `Their note: ${pricing}\n\n` : ''}Discounts of $5/hr or more need your approval. Please approve or decline and let ${user.name || 'them'} know.`,
        JSON.stringify([LIAM]), user.email, user.name || user.email, JSON.stringify([{ centreKey: centre.centreKey, name: centre.name }])]
    });
    await db.execute({ sql: 'UPDATE dormant_touchpoints SET approval_task_id = ? WHERE id = ?', args: [taskId, row.id] });
    row.approval_task_id = taskId;
  }

  await sendTouchpointSignal(row.id).catch(() => {});
  return (await db.execute({ sql: 'SELECT * FROM dormant_touchpoints WHERE id = ?', args: [row.id] })).rows[0];
}

async function sendTouchpointSignal(id) {
  const db = getDb();
  const t = (await db.execute({ sql: 'SELECT * FROM dormant_touchpoints WHERE id = ?', args: [id] })).rows[0];
  if (!t || t.cio_status === 'sent') return t && t.cio_status;
  if (!fbf.cioTrackConfig().ready) return 'pending';
  try {
    const ct = await fbf.resolveContact({ centreKey: t.centre_key });
    const ident = await fbf.cioIdentifierFor({ contact_email: ct && ct.email }, ct);
    if (!ident) {
      await db.execute({ sql: "UPDATE dormant_touchpoints SET cio_status = 'no_profile' WHERE id = ?", args: [id] });
      return 'no_profile';
    }
    // Event contract agreed with RT - Customer.io (22 Oct): set the attribute
    // FIRST (automations filter on it), THEN send the event. No
    // first_booking_free_tagged here, even with FBF ticked: the dormant FBF
    // journey (#38) sends those emails. sendCioSignal does the profile update
    // before the event.
    await fbf.sendCioSignal(ident, { dormant_touchpoint_fbf: !!t.first_booking_free }, 'dormant_touchpoint_complete', {
      first_booking_free: !!t.first_booking_free, centre_key: t.centre_key, centre_name: t.centre_name, state: t.state || '', partner_name: t.completed_by_name || ''
    });
    await db.execute({ sql: "UPDATE dormant_touchpoints SET cio_status = 'sent', cio_sent_at = now(), cio_identifier = ?, cio_error = NULL WHERE id = ?", args: [ident, id] });
    if (t.first_booking_free) await db.execute({ sql: "UPDATE first_booking_free_offers SET email_sent_at = COALESCE(email_sent_at, now()), cio_identifier = ?, cio_centre_key = ? WHERE centre_key = ? AND email_status = 'via_dormant'", args: [ident, t.centre_key, t.centre_key] });
    return 'sent';
  } catch (err) {
    await db.execute({ sql: "UPDATE dormant_touchpoints SET cio_status = 'failed', cio_error = ? WHERE id = ?", args: [String(err.message).slice(0, 300), id] });
    return 'failed';
  }
}

// Retried by the same scheduled job as First Booking Free.
async function retryPendingSignals() {
  if (!fbf.cioTrackConfig().ready) return 0;
  const rows = (await getDb().execute({ sql: "SELECT id FROM dormant_touchpoints WHERE cio_status IN ('pending','failed','no_profile')", args: [] })).rows;
  for (const r of rows) await sendTouchpointSignal(r.id);
  return rows.length;
}

module.exports = { computeTrend, DORMANT_DAYS, annotateDormancy, completeTouchpoint, sendTouchpointSignal, retryPendingSignals, latestTouchpoints };
