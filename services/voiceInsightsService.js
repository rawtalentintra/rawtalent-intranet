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
  return { categories: CATEGORIES, pending: Number(pending), recordings: rows.map(r => ({ ...r, insights: Array.isArray(r.insights) ? r.insights : [] })) };
}

module.exports = { analysePending, listInsights, CATEGORIES };
