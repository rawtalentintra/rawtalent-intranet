const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// pg's default DATE (OID 1082) parser builds a JS Date at LOCAL midnight,
// which then shifts a calendar day backward once anything serializes it
// via toISOString/JSON (UTC) if the server's local timezone is ahead of
// UTC — verified live: posting next_step_due_date '2026-07-01' came back
// as '2026-06-30T14:00:00.000Z'. A DATE column has no timezone at all by
// definition, so the fix is to stop pg from turning it into a Date object
// in the first place — return the raw 'YYYY-MM-DD' string Postgres sends,
// unchanged, for every DATE column app-wide (due_date, start_date,
// target_date, end_date, next_step_due_date, …), not just the one that
// happened to surface this.
types.setTypeParser(1082, val => val);

let pool;

// Temporary migration-scaffolding shim (Turso -> Supabase): preserves the
// getDb().execute({ sql, args }) interface used by ~150 call sites across
// routes/*.js and services/*.js, converting SQLite-style `?` placeholders to
// Postgres `$1,$2,...` and returning the same `{ rows }` shape those call
// sites already destructure. This is NOT meant to be a permanent
// abstraction — as files get touched for the CRM buildout, prefer writing
// native pg queries directly instead of leaning on this further.
function toPgQuery(sql, args) {
  let i = 0;
  const text = sql.replace(/\?/g, () => `$${++i}`);
  return { text, values: args || [] };
}

function getDb() {
  if (!pool) {
    pool = new Pool({
      host: process.env.SUPABASE_DB_HOST,
      port: process.env.SUPABASE_DB_PORT,
      database: process.env.SUPABASE_DB_NAME,
      user: process.env.SUPABASE_DB_USER,
      password: process.env.SUPABASE_DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      max: 10
    });
    // pg's Pool emits 'error' when an IDLE client hits a connection-level
    // problem (network blip, Supabase restarting the connection, etc.) —
    // with no listener, Node treats that as an unhandled error and crashes
    // the entire process, not just the one in-flight request.
    pool.on('error', err => console.error('Unexpected Postgres pool error:', err.message));
  }
  return {
    async execute(arg) {
      const sql = typeof arg === 'string' ? arg : arg.sql;
      const args = typeof arg === 'string' ? undefined : arg.args;
      const { text, values } = toPgQuery(sql, args);
      const result = await pool.query(text, values);
      return { rows: result.rows, rowsAffected: result.rowCount };
    }
  };
}

// getDb().execute() grabs a (possibly different) connection from the pool
// on every call, so several calls in a row are NOT a transaction — fine for
// almost everything this app does, but wrong for a bulk refresh like the RT
// candidates sync, where a failure partway through must never leave readers
// looking at a half-old-half-new table. This checks out one client, runs
// the callback against it (via the same execute({sql,args}) shape so
// existing query code doesn't need to change), and commits/rolls back as a
// single unit.
async function transaction(callback) {
  getDb(); // ensures pool is initialized
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scopedDb = {
      async execute(arg) {
        const sql = typeof arg === 'string' ? arg : arg.sql;
        const args = typeof arg === 'string' ? undefined : arg.args;
        const { text, values } = toPgQuery(sql, args);
        const result = await client.query(text, values);
        return { rows: result.rows, rowsAffected: result.rowCount };
      }
    };
    const result = await callback(scopedDb);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const ECEC_GLOSSARY = [
  { term: 'ASQA', definition: 'Australian Skills Quality Authority — the national regulator for vocational education and training (VET) in Australia.' },
  { term: 'WWCC', definition: 'Working With Children Check — mandatory government clearance required for anyone working with children in Australia.' },
  { term: 'DNU', definition: 'Do Not Use — an internal status flag marking an educator as ineligible for placement.' },
  { term: 'ECEC', definition: 'Early Childhood Education and Care — the regulated sector covering childcare centres and preschools.' },
  { term: 'RTO', definition: 'Registered Training Organisation — a government-accredited provider of vocational education and training qualifications.' },
  { term: 'SPES', definition: 'SPES Education — a former RTO whose qualifications have been cancelled by ASQA.' },
  { term: 'RFC', definition: 'Reason for Calling — the purpose/reason field logged when making a call note.' },
  { term: 'ROTC', definition: 'Result of the Call — the outcome field logged after completing a call.' },
  { term: 'EOD', definition: 'End of Day — used in handover notes and shift summaries.' },
  { term: 'CXL', definition: 'Cancellation — shorthand used internally for a cancelled booking or shift.' },
  { term: 'Fill Rate', definition: 'The percentage of requested shifts that were successfully staffed with an educator.' },
  { term: 'Room Leader', definition: 'The senior qualified educator responsible for a specific room within a childcare centre.' },
  { term: 'Induction', definition: 'A mandatory orientation conducted by the childcare centre before an educator begins their first shift there.' },
  { term: 'Account Freeze', definition: 'A temporary restriction placed on an educator\'s account, preventing new bookings until resolved.' },
  { term: 'Red Zone', definition: 'An account restriction status indicating serious non-compliance — one step below DNU.' },
  { term: 'Workforce Registry', definition: 'A government registry for tracking qualified Early Childhood Education and Care educators.' },
  { term: 'Handover', definition: 'Shift-to-shift notes passed between the morning and afternoon teams to ensure continuity.' },
  { term: 'Admin Portal', definition: 'The internal platform used by the RawTalent team for managing bookings, timesheets, and educator profiles.' },
  { term: 'Booking ID', definition: 'A unique identifier assigned to each shift booking record in the Admin Portal.' },
  { term: 'Candidate ID', definition: 'A unique identifier for each educator profile used when searching or assigning in the system.' },
  { term: 'Unfilled Booking', definition: 'A shift request from a centre that has not yet been assigned an educator.' },
  { term: 'No-Show', definition: 'When an educator fails to attend a confirmed shift without prior notice.' },
  { term: 'VIC', definition: 'Victoria — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'SA', definition: 'South Australia — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'QLD', definition: 'Queensland — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'ACT', definition: 'Australian Capital Territory — one of the regions where RawTalent operates educator placements.' },
  { term: 'Cert III', definition: 'Certificate III in Early Childhood Education and Care — the minimum qualification required for most casual educator roles.' },
  { term: 'Diploma', definition: 'Diploma of Early Childhood Education and Care — a higher qualification required for Room Leader and senior roles.' },
  { term: 'NQF', definition: 'National Quality Framework — the regulatory framework governing the quality of early childhood education and care services in Australia.' },
  { term: 'NQS', definition: 'National Quality Standard — the benchmark for quality in early childhood education and care services under the NQF.' },
  { term: 'ACECQA', definition: 'Australian Children\'s Education and Care Quality Authority — the national body overseeing the NQF and quality standards.' },
  { term: 'Centre', definition: 'A childcare service or client site where RawTalent places casual educators.' },
  { term: 'Educator', definition: 'A casual worker placed by RawTalent into childcare centres — must hold appropriate qualifications and clearances.' },
  { term: 'Booking', definition: 'A confirmed shift placement — the core transaction matching an educator to a centre for a specific date and time.' },
];

async function initDatabase() {
  const db = getDb();

  // Schema lives in db/schema.sql (Postgres DDL) — every statement in it is
  // idempotent (IF NOT EXISTS), so re-running it on every boot is safe and
  // keeps a freshly-provisioned Supabase project in sync automatically.
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await runSchemaSql(schemaSql);

  // One-time seed for "Our Team" — only runs while the table is still empty,
  // so it never overwrites real edits made later through the UI. Real data
  // already lives in Supabase after the Turso migration; this is purely a
  // disaster-recovery fallback if the table is ever wiped.
  try {
    const teamCount = await db.execute('SELECT COUNT(*) as n FROM team_members');
    if (Number(teamCount.rows[0].n) === 0) {
      const { v4: uuidv4 } = require('uuid');
      const seedMembers = require('./seedTeamData');
      const idByKey = {};
      seedMembers.forEach(m => { idByKey[m.key] = uuidv4(); });
      for (const m of seedMembers) {
        await db.execute({
          sql: `INSERT INTO team_members
                (id, name, legal_name, position, team, manager_id, sort_order, employment_date, address, birthdate,
                 device_name, headset, internet_connection, backup_available, backup_types, status)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [
            idByKey[m.key], m.name, m.legal_name || null, m.position || null, m.team || null,
            m.manager ? idByKey[m.manager] : null, m.sortOrder || 0, m.employment_date || null,
            m.address || null, m.birthdate || null, m.device_name || null, m.headset || null,
            m.internet_connection || null, m.backup_available || null, JSON.stringify(m.backup_types || []), m.status || 'active'
          ]
        });
      }
      console.log(`✓ Seeded ${seedMembers.length} team members`);
    }
  } catch (err) {
    console.error('Team seed error:', err.message);
  }

  // Keeps sort_order correct for Liam's direct reports even on a DB that was
  // already seeded before this ordering existed — the org chart groups
  // Sophia/Joy as team-leading branches and Yuvraj/Gwen/Jemina into one
  // vertically-stacked column, and needs these values within each group.
  try {
    const centeredOrder = { 'Yuvraj Rao': 0, 'Sophia': 1, 'Joy Victoria': 2, 'Gwen Stocks': 3, 'Jemina Numos': 4 };
    for (const [name, ord] of Object.entries(centeredOrder)) {
      await db.execute({ sql: 'UPDATE team_members SET sort_order = ? WHERE name = ?', args: [ord, name] });
    }
  } catch {}

  const countRes = await db.execute('SELECT COUNT(*) as n FROM glossary');
  if (Number(countRes.rows[0].n) === 0) {
    for (const { term, definition } of ECEC_GLOSSARY) {
      await db.execute({ sql: 'INSERT INTO glossary (term, definition) VALUES (?, ?) ON CONFLICT (term) DO NOTHING', args: [term, definition] });
    }
    console.log(`✓ Glossary seeded with ${ECEC_GLOSSARY.length} ECEC terms`);
  }

  // Expired sessions are only ever deleted lazily (when that exact sid is
  // looked up again after expiring), so a session table can accumulate rows
  // forever. The active-sessions admin panel does a full table scan, so this
  // keeps that scan (and the table itself) from growing unbounded.
  try {
    await db.execute({ sql: 'DELETE FROM sessions WHERE expires IS NOT NULL AND expires < ?', args: [Date.now()] });
  } catch (err) {
    console.error('Session cleanup error:', err.message);
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au';
  const adminPassword = process.env.ADMIN_PASSWORD || 'RawTalent2024!';

  const existRes = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [adminEmail] });
  if (!existRes.rows[0]) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await db.execute({
      sql: `INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, 'Joy — Administrator', 'super_admin')`,
      args: [adminEmail, hash]
    });
    console.log(`✓ Super admin account created: ${adminEmail}`);
  }

  console.log('✓ Database ready');
}

// schema.sql has no bound parameters, so the simple query protocol (a plain
// string with no values) can run it as one multi-statement batch.
async function runSchemaSql(sql) {
  getDb(); // ensures pool is initialized
  await pool.query(sql);
}

module.exports = { getDb, initDatabase, transaction };
