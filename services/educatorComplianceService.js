// One definition of "fully compliant educator", used by Micropods (and anything
// else that must not show someone who isn't ready to work). Pure function over
// an RT candidate record — no database access.
//
// Fully compliant = the NEWEST copy of every document type on file is reviewed
// and in date (any expired document excludes the person), the core set is on
// file and valid (ID, First Aid, Working with Children, child safety training,
// a reviewed qualification), and a non-citizen's visa hasn't expired.
// Superseded older copies don't count against someone. A police check is not
// required (in SA the WWCC is the criminal screen) but if one is on file it
// must be in date. Added 2026-10-12 after the SA ready-educator list found the
// old "no mandatory doc expired or unreviewed" rule both let in people with a
// missing core document and wrongly dropped people whose old, replaced copy was
// expired.
const SENTINELS = ['0001-01-01', '9999-12-31'];
const CORE = [
  ['ID document', /passport|birth cert|citizenship/i],
  ['First Aid', /first aid/i],
  ['Working with Children / vulnerable people', /working with (children|vulnerable)|blue card|\bwwc/i],
  ['Child safety training', /protecting children|child safety|ec-protect|rran|\bran\b/i],
  ['Qualification', /qualification|teachers accreditation/i]
];
const dateOf = v => (v ? String(v).slice(0, 10) : null);

// Returns the reasons this educator is NOT fully compliant ([] = compliant).
// `raw` needs attachedRequirements and visaDetails; today is 'YYYY-MM-DD'.
function complianceReasons(raw, today) {
  const expired = d => d && !SENTINELS.includes(d) && d < today;
  const reasons = [];
  const docs = (raw.attachedRequirements || []).filter(d => !d.isDeleted && d.isActive !== false);
  const byName = new Map();
  for (const d of docs) { const k = (d.requirementName || '').trim(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(d); }
  const valid = d => d.isReviewed === true && !expired(dateOf(d.expiryDate));
  const isQual = n => /qualification\/course of study/i.test(n);
  const rank = d => { const e = dateOf(d.expiryDate); return e === '9999-12-31' ? '9999-12-31' : (!e || e === '0001-01-01') ? '0000-00-00' : e; };
  const best = new Map();
  for (const [k, list] of byName) best.set(k, list.slice().sort((x, y) => (valid(y) - valid(x)) || rank(y).localeCompare(rank(x)))[0]);
  for (const [k, d] of best) {
    if (isQual(k)) { if (d.isReviewed !== true && d.isMandatory) reasons.push(`${k}: not reviewed`); continue; }
    const e = dateOf(d.expiryDate);
    if (expired(e)) reasons.push(`${k}: expired ${e}`);
    else if (d.isReviewed !== true && d.isMandatory) reasons.push(`${k}: not reviewed`);
  }
  for (const [label, re] of CORE) {
    const matching = [...best.entries()].filter(([k]) => re.test(k));
    if (!matching.length) { reasons.push(`${label}: missing`); continue; }
    if (!matching.some(([k, d]) => (isQual(k) ? d.isReviewed === true : valid(d))) && !reasons.some(x => matching.some(([k]) => x.startsWith(k)))) reasons.push(`${label}: not valid`);
  }
  const visa = [].concat(...(raw.visaDetails || [])).filter(Boolean)[0];
  if (visa && visa.isCitizen === false) {
    const e = dateOf(visa.expiryDate);
    if (e && !SENTINELS.includes(e) && e < today) reasons.push(`Visa expired ${e}`);
  }
  return reasons;
}

module.exports = { complianceReasons };
