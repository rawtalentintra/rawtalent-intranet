// Call Analysis and Insights (Joy, 2026-10-14) — the bottom section of WFP
// Performance. For each transcribed voice recording, Claude pulls out short,
// factual points useful to RawTalent as a business: which agencies centres
// use, what they charge versus us, staffing pain points, objections, and
// opportunities. Extracted once per recording and stored, so the page never
// re-reads every transcript. Only facts actually said in the recording.
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');

const CATEGORIES = {
  competitor_pricing: 'Competitor pricing',
  competitors: 'Competitor agencies in use',
  centre_needs: 'Centre needs and pain points',
  objections: 'Objections and reasons for no',
  opportunities: 'Opportunities',
  other: 'Other market intel'
};

const TOOL = {
  name: 'record_insights',
  description: 'Record the business insights from this childcare centre visit/call transcript.',
  input_schema: {
    type: 'object',
    properties: {
      insights: {
        type: 'array',
        description: 'Short factual points useful to RawTalent (a childcare staffing agency) as an industry insight. Empty if the transcript has nothing useful. Never invent anything not said.',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: Object.keys(CATEGORIES) },
            point: { type: 'string', description: 'One plain-English sentence, under 25 words. Include numbers (rates, prices, counts) exactly as said.' },
            agency: { type: 'string', description: 'Competitor agency named, if any (e.g. ANZUK, Entree). Empty if none.' }
          },
          required: ['category', 'point']
        }
      }
    },
    required: ['insights']
  }
};

function client() {
  return process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
}

async function extract(transcript, centreName, location) {
  const c = client();
  if (!c || !transcript || transcript.trim().split(/\s+/).length < 8) return [];
  const res = await c.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: `You read voice notes a RawTalent Workforce Partner recorded after visiting or calling a childcare centre (${centreName || 'unknown centre'}${location ? ', ' + location : ''}). Pull out only facts useful to RawTalent as a business: agencies the centre uses and what they charge (compared with RawTalent where said), staffing pain points, why they said no, and opportunities (e.g. cook placements, multi-site operators). Plain Australian English. Do not invent or infer anything not said. Call record_insights exactly once.`,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'record_insights' },
    messages: [{ role: 'user', content: transcript.slice(0, 12000) }]
  });
  const use = res.content.find(b => b.type === 'tool_use');
  return (use?.input?.insights || []).filter(i => CATEGORIES[i.category] && i.point).map(i => ({ category: i.category, point: String(i.point).slice(0, 300), agency: i.agency ? String(i.agency).slice(0, 80) : null }));
}

// Extracts for any transcribed recording that hasn't been analysed yet.
async function analysePending(limit = 10) {
  const db = getDb();
  let done = 0;
  const jobs = [
    { table: 'lead_recordings', sql: `SELECT r.id, r.transcript, l.centre_name, concat_ws(', ', l.suburb, l.state) loc FROM lead_recordings r JOIN leads l ON l.id = r.lead_id WHERE r.transcript IS NOT NULL AND r.insights_at IS NULL ORDER BY r.created_at LIMIT ?` },
    { table: 'centre_recordings', sql: `SELECT r.id, r.transcript, r.centre_key centre_name, NULL loc FROM centre_recordings r WHERE r.transcript IS NOT NULL AND r.insights_at IS NULL ORDER BY r.created_at LIMIT ?` }
  ];
  for (const j of jobs) {
    const rows = (await db.execute({ sql: j.sql, args: [limit] })).rows;
    for (const r of rows) {
      try {
        const insights = await extract(r.transcript, r.centre_name, r.loc);
        await db.execute({ sql: `UPDATE ${j.table} SET insights = ?, insights_at = now() WHERE id = ?`, args: [JSON.stringify(insights), r.id] });
        done++;
      } catch (err) {
        console.error(`Insight extraction failed (${j.table} ${r.id}):`, err.message);
      }
    }
  }
  return done;
}

// Everything the WFP Performance section shows, newest first.
async function listInsights() {
  const rows = (await getDb().execute({
    sql: `SELECT 'lead' kind, r.id, r.created_at, r.uploaded_by_name, r.uploaded_by_email, r.insights, r.summary,
                 l.id lead_id, l.centre_name, l.suburb, l.state
          FROM lead_recordings r JOIN leads l ON l.id = r.lead_id WHERE r.insights_at IS NOT NULL
          UNION ALL
          SELECT 'centre', r.id, r.created_at, r.uploaded_by_name, r.uploaded_by_email, r.insights, r.summary,
                 NULL, r.centre_key, NULL, NULL
          FROM centre_recordings r WHERE r.insights_at IS NOT NULL
          ORDER BY created_at DESC`,
    args: []
  })).rows;
  const pending = (await getDb().execute({ sql: `SELECT (SELECT count(*) FROM lead_recordings WHERE transcript IS NOT NULL AND insights_at IS NULL) + (SELECT count(*) FROM centre_recordings WHERE transcript IS NOT NULL AND insights_at IS NULL) n`, args: [] })).rows[0].n;
  // Centre recordings only store the centre key — show the real centre name and state.
  let byKey = new Map();
  if (rows.some(r => r.kind === 'centre')) {
    const { centres } = await require('../routes/centres').getCentresAndBookings();
    byKey = new Map(centres.map(c => [c.centreKey, c]));
  }
  return { categories: CATEGORIES, pending: Number(pending), recordings: rows.map(r => {
    const c = r.kind === 'centre' ? byKey.get(r.centre_name) : null;
    return { ...r, centre_key: r.kind === 'centre' ? r.centre_name : null, centre_name: c ? c.name : r.centre_name, state: c ? c.state : r.state, insights: Array.isArray(r.insights) ? r.insights : [] };
  }) };
}

// ── Intelligence Matrix (Liam, Ops Meeting 12 Oct) ─────────────────────
// A per-state playbook a partner reads before a client meeting: 4 short cards
// (competitors & pricing, centre needs, objections + what to say,
// opportunities). Claude groups the raw insights into a few de-duplicated
// bullets, each tied to the recordings it came from; count = how many visits
// it came up in, lastHeard = newest of those. Cached until the set of insights
// for that state changes, so it's only rebuilt when new voice notes arrive.
const MATRIX_CARDS = [
  { key: 'competitors', title: 'Competitors & pricing', from: ['competitors', 'competitor_pricing'] },
  { key: 'needs', title: 'Top centre needs', from: ['centre_needs'] },
  { key: 'objections', title: 'Objections & what to say', from: ['objections'] },
  { key: 'opportunities', title: 'Opportunities', from: ['opportunities', 'other'] }
];
const matrixCache = new Map(); // state -> { signature, matrix }
const STATE_OF = s => ({ victoria: 'VIC', vic: 'VIC', 'south australia': 'SA', sa: 'SA', queensland: 'QLD', qld: 'QLD', 'australian capital territory': 'ACT', act: 'ACT', 'northern territory': 'NT', nt: 'NT', 'new south wales': 'NSW', nsw: 'NSW' })[String(s || '').trim().toLowerCase()] || 'Other';

const MATRIX_TOOL = {
  name: 'record_matrix',
  description: 'Group the numbered insights into a short playbook.',
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(MATRIX_CARDS.map(c => [c.key, {
      type: 'array', maxItems: 5,
      items: {
        type: 'object',
        properties: {
          point: { type: 'string', description: 'One short, plain-English bullet (under 18 words). Merge insights that say the same thing. Keep exact figures and agency names.' },
          say: { type: 'string', description: c.key === 'objections' ? 'A short suggested response a partner could give (under 25 words), consistent with RawTalent: no contracts, no upfront fees, qualified compliant educators, familiar educators.' : 'Leave empty.' },
          sources: { type: 'array', items: { type: 'integer' }, description: 'Numbers of every insight this bullet is based on.' }
        },
        required: ['point', 'sources']
      }
    }])),
    required: MATRIX_CARDS.map(c => c.key)
  }
};

async function buildMatrix(state) {
  const data = await listInsights();
  const recs = data.recordings.filter(r => STATE_OF(r.state) === state);
  const items = [];
  recs.forEach(r => r.insights.forEach(i => items.push({ ...i, r })));
  const signature = items.map(i => `${i.r.kind}${i.r.id}:${i.point}`).join('|');
  const cached = matrixCache.get(state);
  if (cached && cached.signature === signature) return cached.matrix;
  const empty = { state, cards: MATRIX_CARDS.map(c => ({ key: c.key, title: c.title, bullets: [] })), recordings: recs.length };
  const c = client();
  if (!items.length || !c) { matrixCache.set(state, { signature, matrix: empty }); return empty; }
  const lines = items.map((it, n) => `${n + 1}. [${it.category}] ${it.agency ? it.agency + ': ' : ''}${it.point}`).join('\n');
  const res = await c.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
    system: `You turn field notes from RawTalent Workforce Partners' visits to childcare centres in ${state} into a short pre-meeting playbook. Cards: competitors & pricing (from competitors/competitor_pricing), top centre needs (centre_needs), objections (objections), opportunities (opportunities/other). Merge duplicates, rank by how many insights support each bullet, max 5 per card, only facts in the notes. Call record_matrix once.`,
    tools: [MATRIX_TOOL], tool_choice: { type: 'tool', name: 'record_matrix' },
    messages: [{ role: 'user', content: lines }]
  });
  const out = res.content.find(b => b.type === 'tool_use')?.input || {};
  const matrix = {
    state, recordings: recs.length,
    cards: MATRIX_CARDS.map(card => ({
      key: card.key, title: card.title,
      bullets: (out[card.key] || []).map(b => {
        const src = [...new Set((b.sources || []).map(n => items[n - 1]).filter(Boolean).map(i => i.r))];
        const uniq = [...new Map(src.map(r => [r.kind + r.id, r])).values()];
        return {
          point: String(b.point || '').slice(0, 200), say: b.say ? String(b.say).slice(0, 240) : null,
          count: uniq.length,
          lastHeard: uniq.reduce((m, r) => (!m || new Date(r.created_at) > new Date(m) ? r.created_at : m), null),
          sources: uniq.map(r => ({ kind: r.kind, id: r.id, leadId: r.lead_id, centreKey: r.centre_key, centreName: r.centre_name, by: (r.uploaded_by_name || '').split(' ')[0], at: r.created_at, summary: r.summary || null }))
        };
      }).filter(b => b.count).sort((a, b) => b.count - a.count || new Date(b.lastHeard) - new Date(a.lastHeard))
    }))
  };
  matrixCache.set(state, { signature, matrix });
  return matrix;
}

async function matrixStates() {
  const data = await listInsights();
  const counts = {};
  data.recordings.filter(r => r.insights.length).forEach(r => { const s = STATE_OF(r.state); counts[s] = (counts[s] || 0) + 1; });
  return ['VIC', 'SA', 'QLD', 'ACT', 'NT'].map(s => ({ state: s, recordings: counts[s] || 0 }));
}

module.exports = { analysePending, listInsights, CATEGORIES, buildMatrix, matrixStates };
