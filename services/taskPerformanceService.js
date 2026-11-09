// Tasks → Performance (Joy/Sophia, 9 Nov 2026). Per-person task productivity for
// everyone under Sophia on the Our Team org chart. Kept deliberately simple and fair:
//  - Done: tasks marked Done in the period that the person was assigned to.
//  - On time: of those with a due date, the share finished on/before it (Melbourne day).
//  - Typical time: MEDIAN hours from when THIS person was assigned (assignee history)
//    to Done — one stale task can't skew it; old tasks handed over aren't held against them.
//  - Open / Overdue now: current load, independent of the period.
// Shared tasks count for each assignee. No combined score or ranking.
const { getDb } = require('../db/database');

const VIEWERS = ['sophia@rawtalent.com.au', 'liam@rawtalent.com.au', 'joy@rawtalent.com.au'];
const canView = user => !!user && VIEWERS.includes(String(user.email || '').toLowerCase());
const MIN_SAMPLE = 5;

const melDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const lc = e => String(e || '').toLowerCase();
const arr = v => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());

async function opsTeam() {
  const rows = (await getDb().execute('SELECT id, name, email, manager_id, team, status FROM team_members')).rows;
  const head = rows.find(m => /^sophia\b/i.test(m.name || ''));
  const out = [];
  const walk = id => rows.filter(m => m.manager_id === id && m.status !== 'to_hire' && m.status !== 'inactive').forEach(m => { out.push(m); walk(m.id); });
  if (head) walk(head.id);
  return out.filter(m => m.email);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// from/to = YYYY-MM-DD Melbourne days, inclusive.
async function report({ from, to }) {
  const db = getDb();
  const team = await opsTeam();
  const emails = new Set(team.map(m => lc(m.email)));
  const tasks = (await db.execute({ sql: `SELECT t.id, t.title, t.status, t.created_at, t.completed_at, t.due_date, t.assigned_to_emails, d.name AS department
      FROM tasks t LEFT JOIN task_departments d ON d.id = t.department_id
      WHERE t.status <> 'done' OR (t.completed_at >= CAST(? AS date) - interval '1 day' AND t.completed_at < CAST(? AS date) + interval '2 day')`,
    args: [from, to] })).rows;
  const ids = tasks.map(t => t.id);
  const hist = ids.length ? (await db.execute({ sql: `SELECT task_id, previous_assignees, new_assignees, changed_at FROM task_assignee_history
      WHERE task_id = ANY(?) ORDER BY changed_at`, args: [ids] })).rows : [];
  const histBy = new Map();
  hist.forEach(h => { if (!histBy.has(h.task_id)) histBy.set(h.task_id, []); histBy.get(h.task_id).push(h); });
  // When did `email` (last) get assigned to task t, at or before `until`?
  const assignedAt = (t, email, until) => {
    let at = null;
    for (const h of histBy.get(t.id) || []) {
      if (until && new Date(h.changed_at) > new Date(until)) break;
      const was = arr(h.previous_assignees).map(lc).includes(email), now = arr(h.new_assignees).map(lc).includes(email);
      if (now && !was) at = h.changed_at;
    }
    return at || t.created_at;
  };
  const today = melDay(new Date());
  const people = {};
  team.forEach(m => { people[lc(m.email)] = { name: m.name, email: m.email, team: m.team || '', done: [], open: [] }; });
  for (const t of tasks) {
    const who = arr(t.assigned_to_emails).map(lc).filter(e => emails.has(e));
    if (!who.length) continue;
    const due = t.due_date ? String(t.due_date).slice(0, 10) : null;
    for (const e of who) {
      const p = people[e];
      if (t.status === 'done') {
        if (!t.completed_at) continue;
        const day = melDay(t.completed_at);
        if (day < from || day > to) continue;
        const start = assignedAt(t, e, t.completed_at);
        const hours = Math.max(0, (new Date(t.completed_at) - new Date(start)) / 36e5);
        p.done.push({ id: t.id, title: t.title, department: t.department, completedDay: day, due, onTime: due ? day <= due : null, hours });
      } else {
        p.open.push({ id: t.id, title: t.title, department: t.department, status: t.status, due, overdue: !!(due && due < today) });
      }
    }
  }
  const summarise = p => {
    const withDue = p.done.filter(d => d.onTime !== null);
    const enough = p.done.length >= MIN_SAMPLE;
    return {
      name: p.name, email: p.email, team: p.team,
      done: p.done.length,
      onTimePct: enough && withDue.length ? Math.round(withDue.filter(d => d.onTime).length / withDue.length * 100) : null,
      typicalHours: enough ? median(p.done.map(d => d.hours)) : null,
      open: p.open.length, overdue: p.open.filter(o => o.overdue).length,
      enough, tasks: { done: p.done.sort((a, b) => b.completedDay.localeCompare(a.completedDay)), open: p.open }
    };
  };
  const rows = Object.values(people).map(summarise).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
  const allDone = Object.values(people).flatMap(p => p.done);
  const allDue = allDone.filter(d => d.onTime !== null);
  return {
    from, to, minSample: MIN_SAMPLE,
    totals: {
      done: new Set(allDone.map(d => d.id)).size,
      onTimePct: allDue.length ? Math.round(allDue.filter(d => d.onTime).length / allDue.length * 100) : null,
      typicalHours: median(allDone.map(d => d.hours)),
      overdue: new Set(Object.values(people).flatMap(p => p.open.filter(o => o.overdue).map(o => o.id))).size
    },
    people: rows
  };
}

module.exports = { canView, report, VIEWERS };
