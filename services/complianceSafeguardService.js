// Compliance safeguards (Liam via Joy, 23 Oct 2026): protection against a
// "catastrophe where overnight everyone's WWCC check is deleted" in RT.
//  - takeSnapshot(): after each nightly RT sync, copy the key compliance
//    fields for every Active / In Progress educator into compliance_snapshots
//    (from HeartBeat's own cache, read-only; never writes to RT). Kept 90 days.
//  - diffAndAlert(): compare with the previous snapshot. A lost field, a
//    changed WWCC number, an expiry moved EARLIER, a document becoming
//    unreviewed, or an Active educator dropping out of Active is logged to
//    compliance_change_log. If 20+ educators are affected in one day, a
//    high-priority task goes to Joy + Sophia with before/after values so RT can
//    be fixed by hand. Normal renewals (expiry moved later) are not changes.
//  - weeklyBotActivity(): Monday summary task for Joy (Portal Bot edits, QA Bot
//    findings, compliance changes detected).
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const KEEP_DAYS = 90;
const ALERT_EDUCATORS = 20;
const ALERT_EMAILS = ['joy@rawtalent.com.au', 'sophia@rawtalent.com.au'];
const HEARTBEAT_CLASSIFICATION = '16ab121d-9c7f-414b-9bec-5c6dcf4c9ff2'; // management → HeartBeat
const SENTINEL = new Set(['0001-01-01']);

const melbDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
const day = v => { const s = v ? String(v).slice(0, 10) : null; return s && !SENTINEL.has(s) ? s : null; };

// Newest live copy of a document type (by expiry), so a replaced old copy isn't read.
function latestDoc(docs, re) {
  return (docs || []).filter(d => !d.isDeleted && d.isActive !== false && re.test(d.requirementName || ''))
    .sort((a, b) => String(b.expiryDate || '').localeCompare(String(a.expiryDate || '')))[0] || null;
}
function fieldsFor(raw) {
  const docs = raw.attachedRequirements || [];
  const wwc = latestDoc(docs, /working with (children|vulnerable)|blue card|\bwwc/i);
  const fa = latestDoc(docs, /first aid/i);
  const pc = latestDoc(docs, /police check/i);
  const cs = latestDoc(docs, /protecting children|foundations of child safety|ec-protect|rran|\bran\b/i);
  const q = latestDoc(docs, /qualification\/course of study/i);
  return {
    wwcc_number: wwc ? (String(wwc.documentNumber || '').trim() || null) : null,
    wwcc_expiry: wwc ? day(wwc.expiryDate) : null,
    wwcc_reviewed: wwc ? wwc.isReviewed === true : null,
    first_aid_expiry: fa ? day(fa.expiryDate) : null,
    police_expiry: pc ? day(pc.expiryDate) : null,
    child_safety_expiry: cs ? day(cs.expiryDate) : null,
    qualification: (raw.qualifications || [])[0]?.qualificationName || null,
    qualification_reviewed: q ? q.isReviewed === true : null,
    doc_count: docs.filter(d => !d.isDeleted).length
  };
}

async function takeSnapshot(date = melbDate()) {
  const db = getDb();
  const rows = (await db.execute({
    sql: `SELECT user_id, first_name, last_name, status, raw->>'obStatus' ob, raw->'attachedRequirements' reqs, raw->'qualifications' quals
          FROM rt_candidates_cache WHERE is_deleted IS NOT TRUE AND status IN (1, 4)`, args: []
  })).rows;
  await db.execute({ sql: 'DELETE FROM compliance_snapshots WHERE snapshot_date = ?', args: [date] });
  for (let i = 0; i < rows.length; i += 300) {
    const batch = rows.slice(i, i + 300), vals = [];
    const ph = batch.map(r => {
      const f = fieldsFor({ attachedRequirements: r.reqs, qualifications: r.quals });
      vals.push(date, r.user_id, `${r.first_name || ''} ${r.last_name || ''}`.trim(), r.status, r.ob, f.wwcc_number, f.wwcc_expiry, f.wwcc_reviewed,
        f.first_aid_expiry, f.police_expiry, f.child_safety_expiry, f.qualification, f.qualification_reviewed, f.doc_count);
      return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    });
    await db.execute({
      sql: `INSERT INTO compliance_snapshots (snapshot_date, user_id, name, status, ob_status, wwcc_number, wwcc_expiry, wwcc_reviewed, first_aid_expiry, police_expiry, child_safety_expiry, qualification, qualification_reviewed, doc_count) VALUES ${ph.join(',')}`,
      args: vals
    });
  }
  await db.execute({ sql: `DELETE FROM compliance_snapshots WHERE snapshot_date < (CAST(? AS date) - make_interval(days => ?))`, args: [date, KEEP_DAYS] });
  return { date, educators: rows.length };
}

const FIELDS = [
  ['wwcc_number', 'WWCC number'], ['wwcc_expiry', 'WWCC expiry'], ['first_aid_expiry', 'First Aid expiry'],
  ['police_expiry', 'Police check expiry'], ['child_safety_expiry', 'Child safety training expiry'], ['qualification', 'Qualification']
];
const EXPIRIES = new Set(['wwcc_expiry', 'first_aid_expiry', 'police_expiry', 'child_safety_expiry']);
const dstr = v => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));

function changesBetween(prev, cur) {
  const out = [];
  if (!cur) { out.push(['record', 'Educator record', 'present', 'missing from RT data']); return out; }
  if (prev.status === 1 && cur.status !== 1) out.push(['status', 'RT status', 'Active', `status ${cur.status}`]);
  for (const [k, label] of FIELDS) {
    const a = EXPIRIES.has(k) ? dstr(prev[k]) : prev[k], b = EXPIRIES.has(k) ? dstr(cur[k]) : cur[k];
    if (a && !b) out.push([k, label, a, '(removed)']);
    else if (a && b && a !== b) {
      if (EXPIRIES.has(k)) { if (b < a) out.push([k, label, a, b]); } // only an expiry moved EARLIER is suspicious
      else out.push([k, label, a, b]);
    }
  }
  if (prev.wwcc_reviewed === true && cur.wwcc_reviewed === false) out.push(['wwcc_reviewed', 'WWCC reviewed', 'yes', 'no']);
  if (prev.qualification_reviewed === true && cur.qualification_reviewed === false) out.push(['qualification_reviewed', 'Qualification reviewed', 'yes', 'no']);
  return out;
}

async function diffAndAlert(date = melbDate()) {
  const db = getDb();
  const prevDate = (await db.execute({ sql: 'SELECT max(snapshot_date) d FROM compliance_snapshots WHERE snapshot_date < ?', args: [date] })).rows[0]?.d;
  if (!prevDate) return { date, prevDate: null, affected: 0, alerted: false };
  const [prev, cur] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM compliance_snapshots WHERE snapshot_date = ? AND status = 1', args: [prevDate] }).then(r => r.rows),
    db.execute({ sql: 'SELECT * FROM compliance_snapshots WHERE snapshot_date = ?', args: [date] }).then(r => r.rows)
  ]);
  if (!cur.length) return { date, prevDate: dstr(prevDate), affected: 0, alerted: false, note: 'no snapshot for today' };
  const curById = new Map(cur.map(r => [String(r.user_id), r]));
  const rows = [];
  for (const p of prev) {
    for (const [field, label, before, after] of changesBetween(p, curById.get(String(p.user_id)))) rows.push({ userId: p.user_id, name: p.name, field, label, before, after });
  }
  await db.execute({ sql: 'DELETE FROM compliance_change_log WHERE detected_on = ?', args: [date] });
  for (let i = 0; i < rows.length; i += 300) {
    const b = rows.slice(i, i + 300), vals = [];
    const ph = b.map(r => { vals.push(date, r.userId, r.name, r.field, r.before == null ? null : String(r.before), r.after == null ? null : String(r.after)); return '(?,?,?,?,?,?)'; });
    await db.execute({ sql: `INSERT INTO compliance_change_log (detected_on, user_id, name, field, before_value, after_value) VALUES ${ph.join(',')}`, args: vals });
  }
  const affected = new Set(rows.map(r => String(r.userId))).size;
  let alerted = false;
  if (affected >= ALERT_EDUCATORS) {
    const byField = {}; rows.forEach(r => { byField[r.label] = (byField[r.label] || 0) + 1; });
    const lines = rows.slice(0, 150).map(r => `• ${r.name} (RT ${r.userId}) — ${r.label}: ${r.before} → ${r.after}`);
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'management', ?, ?, ?, 'to_do', 'high', ?, NULL, 'system@rawtalent.internal', 'Auto — Compliance safeguard', '[]', '[]', '[]')`,
      args: [uuidv4(), HEARTBEAT_CLASSIFICATION, `⚠️ Compliance data changed for ${affected} educators overnight (${date})`,
        `HeartBeat compared RT's compliance data for Active educators with the day before (${dstr(prevDate)}) and found ${rows.length} change(s) across ${affected} educators. That's more than the ${ALERT_EDUCATORS}-educator safety threshold, so please check RT now.\n\nBy field: ${Object.entries(byField).map(([k, n]) => `${k} ${n}`).join(', ')}.\n\nBefore → after (from HeartBeat's nightly snapshot, so values can be restored by hand in RT):\n${lines.join('\n')}${rows.length > 150 ? `\n…and ${rows.length - 150} more (full list in HeartBeat's compliance_change_log for ${date}).` : ''}\n\nNormal renewals (an expiry moving later) are not counted.`,
        JSON.stringify(ALERT_EMAILS)]
    });
    alerted = true;
  }
  return { date, prevDate: dstr(prevDate), changes: rows.length, affected, alerted };
}

// Run after the nightly sync. Safe to re-run the same day (replaces that day's rows).
async function runNightly() {
  const snap = await takeSnapshot();
  const diff = await diffAndAlert(snap.date);
  console.log(`Compliance snapshot ${snap.date}: ${snap.educators} educators; ${diff.changes || 0} change(s) across ${diff.affected} educator(s)${diff.alerted ? ' — ALERT task created' : ''}.`);
  return { ...snap, ...diff };
}

async function weeklyBotActivity({ createTask = true } = {}) {
  const db = getDb();
  const q = (sql, args = []) => db.execute({ sql, args }).then(r => r.rows).catch(() => []);
  const [edits, qa, comp] = await Promise.all([
    q(`SELECT document, field, count(*) n FROM portal_bot_edit_log WHERE created_at > now() - interval '7 days' GROUP BY 1,2 ORDER BY 3 DESC`),
    q(`SELECT verdict, severity, count(*) n FROM qa_bot_findings WHERE created_at > now() - interval '7 days' GROUP BY 1,2 ORDER BY 3 DESC`),
    q(`SELECT detected_on, count(DISTINCT user_id) educators, count(*) n FROM compliance_change_log WHERE detected_on > (now() AT TIME ZONE 'Australia/Melbourne')::date - 7 GROUP BY 1 ORDER BY 1`)
  ]);
  const sum = (rows, k = 'n') => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const text = [
    `Portal Bot edits (last 7 days): ${sum(edits)}`, ...edits.slice(0, 10).map(r => `  • ${r.document} — ${r.field}: ${r.n}`),
    '', `QA Bot findings (last 7 days): ${sum(qa)}`, ...qa.map(r => `  • ${r.verdict || 'unlabelled'}${r.severity ? ` (${r.severity})` : ''}: ${r.n}`),
    '', `Compliance changes detected in RT data (last 7 days): ${sum(comp)} change(s)`, ...comp.map(r => `  • ${dstr(r.detected_on)}: ${r.n} change(s) across ${r.educators} educator(s)`)
  ].join('\n');
  if (createTask) {
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'management', ?, ?, ?, 'to_do', 'low', ?, NULL, 'system@rawtalent.internal', 'Auto — Bot activity', '[]', '[]', '[]')`,
      args: [uuidv4(), HEARTBEAT_CLASSIFICATION, `Bot activity — week to ${melbDate()}`, text, JSON.stringify(['joy@rawtalent.com.au'])]
    });
  }
  return text;
}

module.exports = { takeSnapshot, diffAndAlert, runNightly, weeklyBotActivity, changesBetween, fieldsFor };
