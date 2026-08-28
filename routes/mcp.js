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
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session — send an initialize request first' }, id: null });
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
  if (!entry || entry.email.toLowerCase() !== req.mcpUser.email.toLowerCase()) {
    res.status(400).send('Invalid or mismatched session');
    return;
  }
  await entry.transport.handleRequest(req, res);
}
router.get('/', requireMcpToken, handleSessionRequest);
router.delete('/', requireMcpToken, handleSessionRequest);

module.exports = router;
