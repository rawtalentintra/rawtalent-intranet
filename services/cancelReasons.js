// RT's booking cancellation reasons, exactly as RT Portal defines them (pulled from
// RT's own Enum/GetBookingCancelCategory + GetBookingCancelSubCategory, 6 Nov 2026).
// The number stored on a cancelled booking (history[].reason) is the sub-category.
//
// Groups (who cancelled):
//   centre   - cancelled by the centre (type 1)
//   educator - cancelled by the educator (types 2 and 3)
//   unfilled - RT couldn't fill it (admin code 50); counts against the fill rate
//   admin    - housekeeping, not a lost booking: reassigned to a favourite,
//              created by mistake/test, duplicate, system error (admin 47-49, 51)
//   none     - no reason picked (0) or an older code from before this list
const REASONS = {
  // Centre: Booking Error
  9: ['centre', 'Booking error', 'Added by mistake'], 10: ['centre', 'Booking error', 'Duplicate booking'],
  11: ['centre', 'Booking error', 'Incorrect date/time entered'], 12: ['centre', 'Booking error', 'Incorrect role booked'],
  // Centre: Service No Longer Required
  13: ['centre', 'Service no longer required', 'No longer needed'], 14: ['centre', 'Service no longer required', 'Reduced child numbers'],
  15: ['centre', 'Service no longer required', 'Staff returned to work'], 16: ['centre', 'Service no longer required', 'Ratio no longer required'],
  // Centre: Alternative Coverage Found
  17: ['centre', 'Alternative coverage found', 'Internal staff available'], 18: ['centre', 'Alternative coverage found', 'Another agency sourced'],
  19: ['centre', 'Alternative coverage found', 'Relief educator sourced directly'],
  // Centre: Operational Changes
  20: ['centre', 'Operational changes', 'Room closure'], 21: ['centre', 'Operational changes', 'Centre closure'],
  22: ['centre', 'Operational changes', 'Change in operating requirements'],
  // Educator: Health / Family / Unavoidable / Advance notice
  23: ['educator', 'Health', 'Sick'], 24: ['educator', 'Health', 'Medical appointment'], 25: ['educator', 'Health', 'Injury'],
  26: ['educator', 'Family / personal emergency', 'Family emergency'], 27: ['educator', 'Family / personal emergency', 'Kin care / carer responsibilities'],
  28: ['educator', 'Family / personal emergency', 'Childcare issues'], 29: ['educator', 'Family / personal emergency', 'Bereavement'],
  30: ['educator', 'Unavoidable circumstances', 'Vehicle breakdown'], 31: ['educator', 'Unavoidable circumstances', 'Public transport disruption'],
  32: ['educator', 'Unavoidable circumstances', 'Natural disaster / severe weather'],
  33: ['educator', 'Advance notice provided', 'Personal commitment'], 34: ['educator', 'Advance notice provided', 'Approved leave'],
  35: ['educator', 'Advance notice provided', 'Kin care (advance notice)'],
  // Educator: Acceptance / Travel / Preference / No reason
  36: ['educator', 'Booking acceptance issues', 'Accepted by accident'], 37: ['educator', 'Booking acceptance issues', 'Double booked / forgot about booking'],
  39: ['educator', 'Travel related', 'Too far from service'], 40: ['educator', 'Travel related', 'Travel time unsuitable'], 41: ['educator', 'Travel related', 'No transport available'],
  42: ['educator', 'Preference based', "Didn't want the shift"], 43: ['educator', 'Preference based', "Didn't like the centre"], 44: ['educator', 'Preference based', 'Preferred another booking'],
  45: ['educator', 'No valid reason provided', 'Unable to provide reason'], 46: ['educator', 'No valid reason provided', 'No response'],
  // Admin
  47: ['admin', 'Admin', 'Reassigned to favourite or preferred educator'], 48: ['admin', 'Admin', 'Created by mistake'],
  49: ['admin', 'Admin', 'Duplicate'], 50: ['unfilled', 'Admin', 'Unfilled'], 51: ['admin', 'Admin', 'System error, manual assignment required']
};
const GROUP_LABELS = { centre: 'Cancelled by centre', educator: 'Cancelled by educator', unfilled: 'Unfilled (RT couldn\'t fill)', admin: 'Admin (reassigned, test, duplicate; not a lost booking)', none: 'No reason recorded' };

// The reason code on a cancelled booking: the latest "Booking Cancelled" history
// entry that carries a reason. RT often writes a second "Booking Cancelled" entry
// with reason 0 right after the real one (11 Nov 2026: 145 of October's 394
// cancellations), so reading only the last entry showed "No reason picked" and
// hid 19 Unfilled shifts. Falls back to 0 only when no entry has a reason.
function reasonCode(b) {
  const logs = (Array.isArray(b.history) ? b.history : []).filter(h => h.statusId === 6);
  const tagged = [...logs].reverse().find(h => Number(h.reason) > 0);
  return tagged ? Number(tagged.reason) : 0;
}
function classify(b) {
  const code = reasonCode(b);
  const r = REASONS[code];
  return r ? { code, group: r[0], category: r[1], reason: r[2] } : { code, group: 'none', category: 'No reason recorded', reason: code ? `Older RT code ${code}` : 'No reason picked' };
}

module.exports = { REASONS, GROUP_LABELS, reasonCode, classify };
