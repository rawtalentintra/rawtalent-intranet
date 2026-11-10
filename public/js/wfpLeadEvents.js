// WFP Performance lead calls/visits — ONE rule set shared by the page
// (views/admin.html) and the MCP get_wfp_performance report, so they agree.
// 1) Logged lead activities (already once per lead+person+channel+day).
// 2) Stage changes, unless something was logged for that lead+channel+day.
// 3) Derived (notes / voice notes): once per lead+person+channel+day, and only
//    if that lead has NO logged or stage-change entry for the channel on the
//    same day or in the 14 days before (11 Nov 2026: late voice notes were
//    counting as a second visit).
(function (root) {
  const DAY_MS = 86400000, LOOKBACK_DAYS = 14;
  const dayKey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
  const dayNum = d => Math.floor(Date.parse(dayKey(d) + 'T00:00:00Z') / DAY_MS);
  function wfpLeadEvents({ log = [], stage = [], derived = [], inPeriod, partnerEmails = [] }) {
    const when = a => a.occurred_at || a.created_at;
    const events = [];
    const logged = new Set(log.map(a => `${a.lead_id}|${a.channel}|${dayKey(when(a))}`));
    log.filter(a => inPeriod(when(a))).forEach(a => events.push({ email: String(a.created_by_email || '').toLowerCase(), channel: a.channel, lead_id: a.lead_id }));
    stage.forEach(e => { if (inPeriod(e.at) && !logged.has(`${e.lead_id}|${e.channel}|${dayKey(e.at)}`)) events.push({ email: e.email, channel: e.channel, lead_id: e.lead_id }); });
    const priorDays = new Map(); // lead|channel -> [dayNum]
    const addPrior = (lead, ch, d) => { const k = lead + '|' + ch; if (!priorDays.has(k)) priorDays.set(k, []); priorDays.get(k).push(dayNum(d)); };
    log.forEach(a => addPrior(a.lead_id, a.channel, when(a)));
    stage.forEach(e => addPrior(e.lead_id, e.channel, e.at));
    const seen = new Set();
    derived.forEach(e => {
      if (!inPeriod(e.at) || !partnerEmails.includes(e.email)) return;
      const d = dayNum(e.at);
      if ((priorDays.get(e.lead_id + '|' + e.channel) || []).some(p => p <= d && p >= d - LOOKBACK_DAYS)) return;
      const k = `${e.lead_id}|${e.channel}|${d}|${e.email}`;
      if (seen.has(k)) return; seen.add(k);
      events.push({ email: e.email, channel: e.channel, lead_id: e.lead_id, derived: true });
    });
    return events;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { wfpLeadEvents };
  else root.wfpLeadEvents = wfpLeadEvents;
})(typeof window !== 'undefined' ? window : globalThis);
