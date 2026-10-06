// First Shift Completion (Liam/Sophia, 2 and 4 Sep): find every educator whose
// FIRST completed shift happened recently, so someone can call the centre for
// feedback and offer to add the educator to the centre's favourites.
//
// "First" is judged from a bounded booking history (LOOKBACK_DAYS) combined
// with the educator's RT account age: an educator whose RT account was created
// inside the lookback window and whose earliest completed booking in it falls
// in the report period has genuinely never worked before. Without the account
// age check, an educator returning after a long gap (no completed shift for
// months) would be wrongly flagged as brand new.
//
// Completed = RT booking statusId 5 (Booking Completed) with a real assignee
// and a booking date that has already happened — same rule as
// educatorEngagementService.js.

const COMPLETED_STATUS_ID = 5;
// 180 days. Shorter windows miss real first shifts: educators who joined 3-6
// months ago and only now got their first booking (12 of 20 in the last 14 days
// when tested at 90). The slowness this costs is handled by caching in
// routes/firstShift.js, not by shrinking the window.
const LOOKBACK_DAYS = 180;
// No SLA was given in the meetings ("proactively call centres after an
// educator's first shift") — a call still outstanding after this many days is
// flagged overdue. One constant so it's easy to change.
const OVERDUE_AFTER_DAYS = 2;

function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

// bookings: raw RT booking rows. candidatesById: Map(String(userId) ->
// { name, phone, email, createdDate }). Returns one record per educator whose
// first completed shift is within the last `days` days, newest first.
function findFirstShifts(bookings, candidatesById, { days = 14, now = Date.now() } = {}) {
  const lookbackStart = now - LOOKBACK_DAYS * 86400000;
  const periodStart = dayStart(new Date(now - days * 86400000)).getTime();
  const earliest = new Map();
  for (const b of bookings || []) {
    if (!b || b.isDeleted || b.statusId !== COMPLETED_STATUS_ID || !b.assignedUserId || !b.bookingDate) continue;
    const t = new Date(b.bookingDate).getTime();
    if (isNaN(t) || t > now) continue;
    const key = String(b.assignedUserId);
    const cur = earliest.get(key);
    if (!cur || t < cur.t || (t === cur.t && new Date(b.startTime).getTime() < new Date(cur.b.startTime).getTime())) earliest.set(key, { t, b });
  }
  const out = [];
  for (const [userId, { t, b }] of earliest) {
    if (t < periodStart) continue;
    const cand = candidatesById.get(userId);
    // No RT record, or account older than the window we can see history for:
    // can't be sure this was their first shift, so don't claim it.
    if (!cand || !cand.createdDate) continue;
    const created = new Date(cand.createdDate).getTime();
    if (isNaN(created) || created < lookbackStart) continue;
    out.push({
      educatorUserId: userId,
      educatorName: cand.name || b.assignedCandidateName || `Educator #${userId}`,
      educatorPhone: cand.phone || null,
      educatorEmail: cand.email || null,
      bookingId: String(b.clientBookingId),
      firstShiftDate: new Date(t).toISOString().slice(0, 10),
      clientId: b.clientId ?? null,
      locationId: b.locationId ?? null,
      centreName: b.locationName || b.clientName || 'Unknown centre',
      daysSince: Math.floor((dayStart(now).getTime() - dayStart(t).getTime()) / 86400000)
    });
  }
  out.sort((a, b) => (a.firstShiftDate < b.firstShiftDate ? 1 : a.firstShiftDate > b.firstShiftDate ? -1 : 0));
  return out;
}

module.exports = { findFirstShifts, LOOKBACK_DAYS, OVERDUE_AFTER_DAYS, COMPLETED_STATUS_ID };
