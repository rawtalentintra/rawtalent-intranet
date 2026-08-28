// HeartBeat's MCP server — lets a user connect HeartBeat as a Custom
// Connector in Claude (claude.ai → Settings → Connectors → Add custom
// connector, URL: https://<this app>/mcp, using a personal access token
// generated in HeartBeat's own Settings). Authenticated separately from
// the rest of the app: an MCP client is a server-to-server caller, not
// a browser, so it uses a bearer token (mcpTokenService) instead of the
// session cookie/Passport login every other route relies on.
//
// Deliberately read-mostly for this first version — tools that look
// things up (KB search, Ask AI, your own tasks/leave requests, an org
// lookup) rather than ones that change data. A write action invoked by
// an LLM carries more risk than a button a human clicks; if that's
// wanted later it should be its own deliberate addition, not bundled
// into the first pass.
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { getDb } = require('../db/database');
const mcpTokens = require('../services/mcpTokenService');
const aiService = require('../services/aiService');
const rtApi = require('../services/rtApiReportService');
// Reuses routes/centres.js's own cached client+booking fetch (its
// module.exports.getCentresAndBookings) rather than re-deriving a third
// copy of "pull every RT client" — same 5-minute in-memory cache, so a
// second search_centres call moments later doesn't re-hit RT's API.
const { getCentresAndBookings } = require('./centres');

// sessionId -> { transport, email } — an MCP "session" spans several
// JSON-RPC calls (initialize, then repeated tool calls) over what the
// Custom Connector treats as one connection. email is recorded at
// session-init time and re-checked on every subsequent request against
// that request's own bearer token, so a leaked/guessed session id still
// can't be ridden by a different token than the one that created it —
// defense in depth on top of the session id itself already being a
// random UUID.
const sessions = {};

function buildServerForUser(email) {
  const server = new McpServer({ name: 'rawtalent-heartbeat', version: '1.0.0' });

  server.registerTool('search_kb_articles', {
    title: 'Search HeartBeat KB Articles',
    description: 'Full-text search over RawTalent\'s internal knowledge base (policies, SOPs, how-tos). Returns matching articles\' titles, summaries, and categories.',
    inputSchema: { query: z.string().describe('What to search for'), limit: z.number().int().min(1).max(20).optional() }
  }, async ({ query, limit }) => {
    const res = await getDb().execute({
      sql: `SELECT id, title, summary, category, tags, updated_at FROM articles
            WHERE published = true AND search_vector @@ websearch_to_tsquery('english', ?)
            ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', ?)) DESC LIMIT ?`,
      args: [query, query, limit || 8]
    });
    if (!res.rows.length) return { content: [{ type: 'text', text: `No articles matched "${query}".` }] };
    const text = res.rows.map(a => `• ${a.title} (${a.category || 'Uncategorized'})\n  ${a.summary || ''}`).join('\n\n');
    return { content: [{ type: 'text', text }] };
  });

  server.registerTool('ask_rawtalent_ai', {
    title: 'Ask HeartBeat AI',
    description: 'Ask a question about RawTalent policy/process and get an answer grounded in the internal knowledge base — the same Ask AI feature inside HeartBeat itself.',
    inputSchema: { question: z.string() }
  }, async ({ question }) => {
    const { answer, sources } = await aiService.askQuestion(question, email, []);
    const sourceLine = sources?.length ? `\n\nSources: ${sources.map(s => s.title).join(', ')}` : '';
    return { content: [{ type: 'text', text: answer + sourceLine }] };
  });

  server.registerTool('get_my_tasks', {
    title: 'Get My Tasks',
    description: 'Lists tasks assigned to you in HeartBeat, optionally including already-completed ones.',
    inputSchema: { includeCompleted: z.boolean().optional() }
  }, async ({ includeCompleted }) => {
    const res = await getDb().execute({
      sql: `SELECT title, status, priority, due_date FROM tasks
            WHERE assigned_to_emails @> ?::jsonb ${includeCompleted ? '' : "AND status != 'done'"}
            ORDER BY due_date ASC NULLS LAST LIMIT 30`,
      args: [JSON.stringify([email])]
    });
    if (!res.rows.length) return { content: [{ type: 'text', text: 'No tasks assigned to you right now.' }] };
    const text = res.rows.map(t => `• [${t.status}/${t.priority}] ${t.title}${t.due_date ? ` — due ${new Date(t.due_date).toLocaleDateString('en-AU')}` : ''}`).join('\n');
    return { content: [{ type: 'text', text }] };
  });

  server.registerTool('get_my_leave_requests', {
    title: 'Get My Leave Requests',
    description: 'Lists your own leave requests and their current status (pending, approved, rejected).',
    inputSchema: { limit: z.number().int().min(1).max(30).optional() }
  }, async ({ limit }) => {
    const res = await getDb().execute({
      sql: `SELECT start_date, end_date, status, reason FROM leave_requests
            WHERE LOWER(user_email) = LOWER(?) ORDER BY created_at DESC LIMIT ?`,
      args: [email, limit || 10]
    });
    if (!res.rows.length) return { content: [{ type: 'text', text: 'No leave requests on file.' }] };
    const text = res.rows.map(l => `• ${new Date(l.start_date).toLocaleDateString('en-AU')} – ${new Date(l.end_date).toLocaleDateString('en-AU')}: ${l.status} (${l.reason})`).join('\n');
    return { content: [{ type: 'text', text }] };
  });

  server.registerTool('get_team_member', {
    title: 'Look Up a Team Member',
    description: 'Looks up a RawTalent team member by name or email — position, team, phone.',
    inputSchema: { nameOrEmail: z.string() }
  }, async ({ nameOrEmail }) => {
    const res = await getDb().execute({
      sql: `SELECT name, legal_name, position, team, phone, email FROM team_members
            WHERE status = 'active' AND (name ILIKE ? OR legal_name ILIKE ? OR LOWER(email) = LOWER(?)) LIMIT 5`,
      args: [`%${nameOrEmail}%`, `%${nameOrEmail}%`, nameOrEmail]
    });
    if (!res.rows.length) return { content: [{ type: 'text', text: `No team member matching "${nameOrEmail}".` }] };
    const text = res.rows.map(m => `• ${m.legal_name || m.name} — ${m.position || 'no position on file'}${m.team ? ` (${m.team})` : ''}${m.email ? `, ${m.email}` : ''}${m.phone ? `, ${m.phone}` : ''}`).join('\n');
    return { content: [{ type: 'text', text }] };
  });

  // ── Educator/candidate + centre database (2026-08-29) ──────────────
  // Added after Joy pointed out the original 5 tools never reached RT's
  // real educator/candidate or client data at all — everything above is
  // HeartBeat's own tables (KB, tasks, leave, team directory), not RT's.
  // search_educators/get_educator read the same rt_candidates_cache sync
  // table Tasks' own auto-link feature uses (services/
  // taskPersonMatchService.js) — a local Postgres cache of RT's real
  // candidate database, refreshed nightly, not a live RT call. Centres
  // are the opposite: RT has no local cache table for clients (routes/
  // centres.js's own comment explains why — ~360 active centres is cheap
  // enough to just re-fetch live, unlike candidates' ~25k rows), so
  // search_centres reuses that route's exported getCentresAndBookings()
  // and its existing 5-minute in-memory cache.
  server.registerTool('search_educators', {
    title: 'Search Educators / Candidates',
    description: 'Search RawTalent\'s real educator/candidate database (RT) by name, phone, or email. Returns each match\'s contact info, active status, any expiring compliance documents, and a link to their full RT profile.',
    inputSchema: { query: z.string().describe('A name, phone number, or email to search for'), limit: z.number().int().min(1).max(20).optional() }
  }, async ({ query, limit }) => {
    const digits = query.replace(/\D/g, '');
    const db = getDb();
    // Phone is the strong signal (near-unique once normalised) — same
    // 9-trailing-digit comparison taskPersonMatchService.js uses, so
    // "0417225760", "+61417225760" and "417225760" all match each other.
    const res = digits.length >= 8
      ? await db.execute({
          sql: `SELECT user_id, first_name, last_name, contact_no, email, suburb, is_active, expiring_docs_count
                FROM rt_candidates_cache
                WHERE RIGHT(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) = RIGHT(?, 9)
                LIMIT ?`,
          args: [digits, limit || 10]
        })
      : await db.execute({
          sql: `SELECT user_id, first_name, last_name, contact_no, email, suburb, is_active, expiring_docs_count,
                       similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ?) AS sim
                FROM rt_candidates_cache
                WHERE similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ?) > 0.25 OR email ILIKE ?
                ORDER BY sim DESC NULLS LAST LIMIT ?`,
          args: [query, query, `%${query}%`, limit || 10]
        });
    if (!res.rows.length) return { content: [{ type: 'text', text: `No educators matched "${query}".` }] };
    const text = res.rows.map(r => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unnamed candidate';
      const flags = [r.is_active ? 'active' : 'inactive', r.expiring_docs_count ? `⚠️ ${r.expiring_docs_count} expiring doc(s)` : null].filter(Boolean).join(', ');
      return `• ${name} (id ${r.user_id}) — ${r.contact_no || 'no phone'}${r.email ? `, ${r.email}` : ''}${r.suburb ? `, ${r.suburb}` : ''} — ${flags}\n  Profile: https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${r.user_id}`;
    }).join('\n\n');
    return { content: [{ type: 'text', text }] };
  });

  server.registerTool('get_educator', {
    title: 'Get Educator Details',
    description: 'Full profile for one educator/candidate by their RT user id (get the id from search_educators first) — contact info, addresses, qualifications, and compliance documents on file, including expiry dates.',
    inputSchema: { userId: z.union([z.string(), z.number()]).describe('The RT candidate user id') }
  }, async ({ userId }) => {
    const res = await getDb().execute({ sql: `SELECT * FROM rt_candidates_cache WHERE user_id = ?`, args: [userId] });
    const row = res.rows[0];
    if (!row) return { content: [{ type: 'text', text: `No educator found with id ${userId}.` }] };
    const raw = row.raw || {};
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unnamed candidate';
    const lines = [
      `${name} (id ${row.user_id})`,
      `Phone: ${row.contact_no || '—'} · Email: ${row.email || '—'}`,
      `Status: ${row.is_active ? 'Active' : 'Inactive'}${row.is_deleted ? ' (deleted)' : ''}${row.suburb ? ` · Suburb: ${row.suburb}` : ''}`,
      row.expiring_docs_count ? `⚠️ ${row.expiring_docs_count} expiring compliance document(s)` : null
    ];
    if (Array.isArray(raw.addresses) && raw.addresses.length) {
      lines.push('', 'Addresses:', ...raw.addresses.map(a => `  • ${[a.addressLine1, a.addressLine2, a.suburb, a.state, a.postCode].filter(Boolean).join(', ')}`));
    }
    if (Array.isArray(raw.qualifications) && raw.qualifications.length) {
      lines.push('', 'Qualifications:', ...raw.qualifications.map(q => `  • ${q.qualificationName || 'Unnamed qualification'}${q.qualified ? ' (qualified)' : ''}`));
    }
    if (Array.isArray(raw.attachedRequirements) && raw.attachedRequirements.length) {
      // RT uses two sentinel dates, not just missing/null: '0001-01-01'
      // (unset) and '9999-12-31' (this document type never expires) —
      // confirmed against real data (Passport/Payslip/etc. all carry the
      // 9999 sentinel). Both read as noise, not a real date, to a human.
      lines.push('', 'Compliance documents:', ...raw.attachedRequirements.map(r => {
        const hasRealExpiry = r.expiryDate && !r.expiryDate.startsWith('0001') && !r.expiryDate.startsWith('9999');
        const expiry = hasRealExpiry ? ` — expires ${new Date(r.expiryDate).toLocaleDateString('en-AU')}` : '';
        return `  • ${r.requirementName || 'Document'}${expiry}${r.isMandatory ? ' (mandatory)' : ''}`;
      }));
    }
    lines.push('', `Profile: https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${row.user_id}`);
    return { content: [{ type: 'text', text: lines.filter(l => l !== null).join('\n') }] };
  });

  server.registerTool('search_centres', {
    title: 'Search Centres / Clients',
    description: 'Search RawTalent\'s active RT client centres by name or suburb. Returns each match\'s location and contact number.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() }
  }, async ({ query, limit }) => {
    const { centres } = await getCentresAndBookings();
    const q = query.toLowerCase();
    const matches = centres.filter(c => (c.name || '').toLowerCase().includes(q) || (c.suburb || '').toLowerCase().includes(q)).slice(0, limit || 10);
    if (!matches.length) return { content: [{ type: 'text', text: `No centres matched "${query}".` }] };
    const text = matches.map(c => `• ${c.name}${c.suburb ? ` — ${c.suburb}${c.state ? `, ${c.state}` : ''}` : ''}${c.contactNo ? ` · ${c.contactNo}` : ''}`).join('\n');
    return { content: [{ type: 'text', text }] };
  });

  return server;
}

async function requireMcpToken(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const user = token ? await mcpTokens.verifyToken(token) : null;
  if (!user) {
    // Points an OAuth-aware client (Claude's Custom Connector flow) at
    // the discovery document for routes/mcpOAuth.js instead of leaving
    // it to guess — see that file's header comment for the full flow.
    // Derived from the actual request, not process.env.APP_URL — that
    // var turned out unset/wrong in Railway production and silently
    // pointed Claude at http://localhost:3000 (2026-08-28, live report).
    res.set('WWW-Authenticate', `Bearer resource_metadata="${req.protocol}://${req.get('host')}/.well-known/oauth-protected-resource/mcp"`);
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or missing access token' }, id: null });
    return;
  }
  // super_admin only for now (Joy 2026-08-28, same restriction as
  // routes/mcpTokens.js — token generation is already gated there, but
  // this is the actual data-access endpoint, so it gets its own
  // independent check rather than trusting that gate alone).
  if (user.role !== 'super_admin') {
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP access is not enabled for this account' }, id: null });
    return;
  }
  req.mcpUser = user;
  next();
}

router.post('/', requireMcpToken, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let entry = sessionId ? sessions[sessionId] : null;

    if (entry) {
      // Same defense-in-depth check described above the sessions map.
      if (entry.email.toLowerCase() !== req.mcpUser.email.toLowerCase()) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Token does not match this session' }, id: null });
        return;
      }
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { sessions[sid] = { transport, email: req.mcpUser.email }; }
      });
      transport.onclose = () => { if (transport.sessionId) delete sessions[transport.sessionId]; };
      const server = buildServerForUser(req.mcpUser.email);
      await server.connect(transport);
      entry = { transport, email: req.mcpUser.email };
    } else {
      // 404, not 400 — this is the SDK's own documented convention
      // ("Requests with invalid session IDs are rejected with 404 Not
      // Found", streamableHttp.js's header comment) and per the MCP
      // Streamable HTTP spec, 404 is specifically the signal a client is
      // expected to treat as "this session is gone, silently start a new
      // one" rather than a hard failure. `sessions` is in-memory, so it's
      // wiped on every deploy — every session alive at that moment hits
      // this exact branch on its next call. Getting the status code right
      // is the difference between "reconnects itself" and "every deploy
      // breaks the connector until you manually disconnect/reconnect in
      // Claude" — confirmed live 2026-08-29 as the latter, with a plain
      // 400 here.
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — the server may have restarted. Send a new initialize request.' }, id: null });
      return;
    }
    await entry.transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
  }
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const entry = sessionId ? sessions[sessionId] : null;
  // 404 specifically for "doesn't exist" (see the matching comment in the
  // POST handler above — same reasoning, same in-memory-sessions-die-on-
  // deploy cause) vs. 401 for "exists, but for a different token's user" —
  // a real security-relevant rejection, not something a client should
  // silently paper over by reinitializing.
  if (!entry) { res.status(404).send('Session not found — the server may have restarted. Send a new initialize request.'); return; }
  if (entry.email.toLowerCase() !== req.mcpUser.email.toLowerCase()) {
    res.status(401).send('Token does not match this session');
    return;
  }
  await entry.transport.handleRequest(req, res);
}
router.get('/', requireMcpToken, handleSessionRequest);
router.delete('/', requireMcpToken, handleSessionRequest);

module.exports = router;
