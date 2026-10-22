// Weekly / monthly Workforce Partner report (services/wfpReportService.js).
// super_admin + Liam only for now (same audience as the MCP connector).
const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');
const svc = require('../services/wfpReportService');
const { canUseMcp } = require('../services/mcpTokenService');

router.use((req, res, next) => (req.user && canUseMcp(req.user.email, req.user.role)) ? next() : res.status(404).json({ error: 'Not found' }));

async function getOrBuild(type, start, refresh) {
  const t = type === 'month' ? 'month' : 'week';
  const p = start ? svc.periodBounds(t, start) : svc.lastCompletedPeriod(t);
  if (!refresh) {
    const row = (await getDb().execute({ sql: 'SELECT data FROM wfp_reports WHERE period_type = ? AND period_start = ?', args: [t, p.start] })).rows[0];
    if (row) return row.data;
  }
  return svc.generateAndSave(t, p.start);
}

router.get('/', async (req, res) => {
  try { res.json(await getOrBuild(req.query.type, req.query.start, req.query.refresh === '1')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/saved', async (req, res) => {
  try {
    const rows = (await getDb().execute({ sql: 'SELECT period_type, period_start, generated_at FROM wfp_reports ORDER BY period_start DESC LIMIT 60', args: [] })).rows;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const LABEL = { leadCalls: 'Lead calls', centreCalls: 'Centre calls', leadVisits: 'Lead visits', centreVisits: 'Centre visits', leadsCreated: 'Leads created', dormantTouchpoints: 'Dormant touch points', fbfOffers: 'First booking free offers', voiceNotes: 'Voice notes' };

router.get('/pdf', async (req, res) => {
  try {
    const r = await getOrBuild(req.query.type, req.query.start, false);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="WFP-${r.type}-report-${r.period.start}.pdf"`);
    doc.pipe(res);
    const navy = '#1F2A44';
    const h = t => { doc.moveDown(0.8).fillColor(navy).font('Helvetica-Bold').fontSize(13).text(t).moveDown(0.3).font('Helvetica').fontSize(9.5).fillColor('#111'); };
    const row = (cells, widths, bold) => {
      const y = doc.y; let x = 40;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
      cells.forEach((c, i) => { doc.text(String(c ?? '—'), x, y, { width: widths[i] - 6 }); x += widths[i]; });
      doc.x = 40; doc.moveDown(0.25); if (doc.y > 770) doc.addPage();
    };
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(18).text(`Workforce Partner ${r.type === 'month' ? 'monthly' : 'weekly'} report`);
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(`${r.period.start} to ${r.period.end} (end exclusive) · generated ${new Date(r.generatedAt).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}`);

    h('A. Activity (this period / last period / 4-period average)');
    const parts = r.activity.map(a => a.partner);
    row(['', ...parts], [150, ...parts.map(() => 120)], true);
    Object.keys(LABEL).forEach(k => row([LABEL[k], ...r.activity.map(a => { const m = a.metrics.find(x => x.key === k); return `${m.current} / ${m.previous} / ${m.avg4}`; })], [150, ...parts.map(() => 120)]));

    h('B. Funnel (leads created this period)');
    const fw = [90, 45, 45, 50, 55, 55, 45, 60, 70];
    row(['Partner', 'Leads', 'Called', 'Visited', 'Set up', '1st booking', 'Repeat', 'Days visit→set-up', 'Visits followed up ≤2d'], fw, true);
    r.funnel.forEach(f => row([f.partner, f.leads, f.called, f.visited, f.setUp, f.firstBooking, f.repeat, f.avgDaysVisitToSetUp ?? '—', f.visitsInPeriod ? `${f.followedUp2d}/${f.visitsInPeriod} (${f.followedUp2dPct}%)` : '—'], fw));
    doc.moveDown(0.3).text(`First booking free (all offers to date): ${r.fbf.offered} offered → ${r.fbf.firstBooking} first booking → ${r.fbf.rebooked30d} rebooked within 30 days.`);

    h('C. Centre health');
    doc.text(r.health.statuses.map(s => `${s.status[0].toUpperCase() + s.status.slice(1)} ${s.count} (${s.change >= 0 ? '+' : ''}${s.change} vs last week)`).join(' · '));
    doc.moveDown(0.3).text(`Outstanding Action Required: unhappy client ${r.health.actionRequired.unhappyClient} · go visit (first booking) ${r.health.actionRequired.goVisit} · centre dormant ${r.health.actionRequired.dormant}`);
    doc.moveDown(0.3);
    row(['Top declining centres', 'State', 'Owner', 'Last 4 wks', 'Prior 8 wks'], [220, 50, 80, 70, 70], true);
    r.health.topDeclining.forEach(c => row([c.name, c.state, c.owner, c.last4, c.prior8], [220, 50, 80, 70, 70]));

    h('D. Bookings and fill by state');
    const dw = [55, 55, 50, 55, 45, 55, 60, 60, 50];
    row(['State', 'Booked', 'Filled', 'Unfilled', 'Open', 'Fill rate', 'Centre canc.', 'Educator canc.', 'Admin'], dw, true);
    r.fill.forEach(s => row([s.state, s.booked, s.filled, s.unfilled, s.open, s.fillRate != null ? `${s.fillRate}%` : '—', s.cancelled.centre, s.cancelled.educator, s.cancelled.admin], dw));
    doc.fontSize(8.5).fillColor('#666').text('Cancellation split is PROVISIONAL until Sophia confirms the RT reason codes.').fontSize(9.5).fillColor('#111');

    h('E. What centres are telling us (Intelligence Matrix)');
    r.matrix.filter(m => m.state).forEach(m => {
      doc.font('Helvetica-Bold').text(`${m.state} (${m.recordings} recordings)`).font('Helvetica');
      [['Competitors & pricing', m.competitors], ['Needs', m.needs], ['Objections', m.objections]].forEach(([t, list]) => doc.text(`${t}: ${list.length ? list.join('; ') : '—'}`));
      doc.moveDown(0.4);
    });
    h('Notes');
    r.notes.forEach(n => doc.text(`• ${n}`));
    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

module.exports = router;
