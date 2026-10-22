// RTO lookup inside HeartBeat (Sophia, 21 Oct; Joy said go ahead 23 Oct).
// Reads training.gov.au's public data (the same JSON the training.gov.au
// website uses). Free, no account or key. It's undocumented, so a format
// change on their side could break it; errors are shown plainly. Read-only.
//
// Sophia's rule (#ob-gurls, 13 Oct): a cancelled RTO is acceptable UNLESS the
// cancellation was ASQA-initiated or the qualification is on ASQA's cancelled
// list. training.gov.au shows both:
//  - registration endReason "…cancelled without consent of the organisation"
//    and/or a regulatory decision of type "Cancellation" → ASQA-initiated
//  - a regulatory decision of type "Cancelled qualifications / statements of
//    attainment" → ASQA has cancelled certificates issued by this RTO
const BASE = 'https://training.gov.au/api';
const cache = new Map(); // url -> { at, data }
const TTL = 60 * 60 * 1000;

async function get(path) {
  const url = `${BASE}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (RawTalent HeartBeat RTO lookup)', Accept: 'application/json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`training.gov.au returned ${r.status}`);
  const data = await r.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}
const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function search(q) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const d = await get(`/search/organisation?searchText=${encodeURIComponent(term)}`);
  return (d?.data || []).filter(o => o.isRto !== false).slice(0, 15).map(o => ({
    code: o.code, legalName: o.legalName, tradingNames: (o.tradingNames || []).map(t => t.name || t).filter(Boolean),
    isCurrent: !!o.isCurrent, flagged: !!o.hasCurrentRestrictionOrRegulatoryDecision
  }));
}

async function details(code, qualificationCode) {
  const c = String(code || '').trim();
  if (!/^\d{1,6}$/.test(c)) throw Object.assign(new Error('Enter an RTO number (digits only)'), { status: 400 });
  const [org, found, registration, decisions, scope] = await Promise.all([
    get(`/organisation/${c}`),
    get(`/search/organisation?searchText=${c}`),
    get(`/organisation/${c}/registration`).catch(() => []),
    get(`/organisation/${c}/regulatorydecision`).catch(() => []),
    get(`/organisation/${c}/scope`).catch(() => null)
  ]);
  if (!org) return null;
  const s = (found?.data || []).find(o => String(o.code) === c) || {};
  const regs = (registration || []).map(r => ({ start: r.startDate, end: r.endDate, endReason: r.endReason || null, regulator: r.exerciser || null }))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  const decs = (decisions || []).filter(d => !d.isHistoric).map(d => ({
    type: d.decisionType, decision: d.decision, status: d.decisionStatus, effective: d.effectiveDate, reference: d.reference,
    review: d.reviewStatus && d.reviewStatus !== 'N/A' ? d.reviewStatus : null, details: strip(d.decisionDetails).slice(0, 600) || null
  }));
  const asqaCancelledRegistration = regs.some(r => /without consent/i.test(r.endReason || '')) || decs.some(d => /^cancellation$/i.test(d.type || '') && /effect/i.test(d.status || ''));
  const asqaCancelledQualifications = decs.filter(d => /cancelled qualifications/i.test(d.type || '') && /effect/i.test(d.status || ''));
  const isCurrent = org.status === 'current' || s.isCurrent === true;

  let verdict;
  if (asqaCancelledQualifications.length) verdict = { level: 'bad', text: 'ASQA has cancelled qualifications / statements of attainment issued by this RTO. Check the dates in the decision below: certificates issued in that period are not valid.' };
  else if (asqaCancelledRegistration) verdict = { level: 'bad', text: 'Registration was cancelled by ASQA (without the RTO\'s consent). Under Sophia\'s rule this is NOT acceptable.' };
  else if (!isCurrent) verdict = { level: 'ok', text: 'Non-current, but not cancelled by ASQA. Under Sophia\'s rule a qualification issued while it was registered is acceptable.' };
  else verdict = { level: 'good', text: 'Current RTO with no ASQA cancellation on record.' };

  const quals = (scope?.value || []).filter(x => x.componentType === 'qualification');
  let qualification = null;
  if (qualificationCode) {
    const qc = String(qualificationCode).trim().toUpperCase();
    const rows = quals.filter(x => String(x.code).toUpperCase() === qc);
    qualification = { code: qc, onScope: rows.length > 0, periods: rows.map(x => ({ title: x.title, start: x.startDate, end: x.endDate, status: x.statusLabel, extent: x.extentLabel })) };
  }
  const childcare = quals.filter(x => /^CHC(3|5)0/.test(x.code) || /early childhood|children'?s services|education and care/i.test(x.title || ''))
    .map(x => ({ code: x.code, title: x.title, start: x.startDate, end: x.endDate, status: x.statusLabel }))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));

  return {
    code: c, legalName: s.legalName || null, tradingNames: (s.tradingNames || []).map(t => t.name || t).filter(Boolean),
    abn: (s.abns || [])[0] || null, status: org.statusLabel || (isCurrent ? 'Current' : 'Non-Current'), isCurrent,
    registrations: regs, decisions: decs, asqaCancelledRegistration, asqaCancelledQualifications: asqaCancelledQualifications.length > 0,
    verdict, qualification, childcareQualifications: childcare, totalQualificationsOnScope: quals.length,
    link: `https://training.gov.au/Organisation/Details/${c}`
  };
}

module.exports = { search, details };
