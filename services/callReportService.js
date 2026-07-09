const Anthropic = require('@anthropic-ai/sdk');
const { RUBRICS } = require('./callGradingService');

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Pure aggregation — no AI involved, so the numeric side of the dashboard
// always works even if ANTHROPIC_API_KEY isn't set.
function computeStats(evaluations, categoryKey) {
  const total = evaluations.length;
  const outcomeBreakdown = { pass: 0, coaching: 0, escalate: 0 };
  const categoryTotals = {}; // key -> { label, sum, count }
  const repMap = {}; // repName -> { repName, count, scoreSum, focusSum, focusCount }
  let overallSum = 0;

  for (const e of evaluations) {
    overallSum += e.overall_score;
    outcomeBreakdown[e.outcome] = (outcomeBreakdown[e.outcome] || 0) + 1;

    for (const c of e.category_scores) {
      if (!categoryTotals[c.key]) categoryTotals[c.key] = { label: c.category, sum: 0, count: 0 };
      categoryTotals[c.key].sum += c.score;
      categoryTotals[c.key].count++;
    }

    const rep = e.rep_name || 'Unknown';
    if (!repMap[rep]) repMap[rep] = { repName: rep, count: 0, scoreSum: 0, focusSum: 0, focusCount: 0 };
    repMap[rep].count++;
    repMap[rep].scoreSum += e.overall_score;
    if (categoryKey) {
      const catScore = e.category_scores.find(c => c.key === categoryKey);
      if (catScore) { repMap[rep].focusSum += catScore.score; repMap[rep].focusCount++; }
    }
  }

  const categoryAverages = Object.entries(categoryTotals)
    .map(([key, v]) => ({ key, label: v.label, avgScore: Math.round((v.sum / v.count) * 100) / 100 }));

  const perRep = Object.values(repMap)
    .map(r => ({
      repName: r.repName,
      callsEvaluated: r.count,
      avgOverallScore: Math.round((r.scoreSum / r.count) * 10) / 10,
      avgFocusScore: categoryKey && r.focusCount ? Math.round((r.focusSum / r.focusCount) * 100) / 100 : null
    }))
    .sort((a, b) => b.callsEvaluated - a.callsEvaluated);

  return {
    total,
    avgOverallScore: total ? Math.round((overallSum / total) * 10) / 10 : 0,
    outcomeBreakdown,
    categoryAverages,
    perRep
  };
}

// Ranks calls by whichever score is in focus (a specific category, or overall)
// and returns the extremes — these become the AI's evidence, keeping the
// prompt bounded regardless of how many evaluations are in the period.
function pickExamples(evaluations, categoryKey, n = 6) {
  const scored = evaluations.map(e => {
    let score = e.overall_score;
    let notes = e.summary;
    if (categoryKey) {
      const c = e.category_scores.find(x => x.key === categoryKey);
      if (c) { score = c.score; notes = c.notes; }
    }
    return { repName: e.rep_name || 'Unknown', callDate: e.call_date, score, notes: notes || '' };
  }).filter(e => e.notes.trim());

  scored.sort((a, b) => b.score - a.score);
  return {
    top: scored.slice(0, n),
    bottom: scored.slice(-n).reverse()
  };
}

async function generateReport(evaluations, filters) {
  const categoryKey = filters.category || null;
  const stats = computeStats(evaluations, categoryKey);

  if (evaluations.length === 0) {
    return { stats, aiReport: null };
  }

  const client = getClient();
  if (!client) {
    return { stats, aiReport: null, aiError: 'AI is not configured. Set ANTHROPIC_API_KEY to generate the narrative report.' };
  }

  const { top, bottom } = pickExamples(evaluations, categoryKey);
  const rubricLabel = filters.rubricType ? (RUBRICS[filters.rubricType]?.label || filters.rubricType) : 'both Educator-Facing and Centre-Facing';
  const focusLabel = categoryKey ? (stats.categoryAverages.find(c => c.key === categoryKey)?.label || categoryKey) : 'overall call quality';
  const scoreUnit = categoryKey ? '/5' : '%';

  const categoryAvgLines = stats.categoryAverages.map(c => `- ${c.label}: ${c.avgScore}/5`).join('\n') || '(none)';
  const perRepLines = stats.perRep.map(r =>
    `- ${r.repName}: ${r.callsEvaluated} call${r.callsEvaluated !== 1 ? 's' : ''}, avg overall ${r.avgOverallScore}%${r.avgFocusScore != null ? `, avg ${focusLabel} ${r.avgFocusScore}/5` : ''}`
  ).join('\n') || '(none)';
  const topLines = top.map(e => `- ${e.repName} (${e.callDate || 'date unknown'}), score ${e.score}${scoreUnit}: ${e.notes}`).join('\n') || '(no notes available)';
  const bottomLines = bottom.map(e => `- ${e.repName} (${e.callDate || 'date unknown'}), score ${e.score}${scoreUnit}: ${e.notes}`).join('\n') || '(no notes available)';

  const system = `You are a call quality analyst for RawTalent, an Australian childcare staffing agency, writing a period report for a super admin reviewing call evaluations from ${rubricLabel} calls.

The quality rubric measures: Opening & Rapport, Active Listening, Compliance Accuracy (zero-tolerance for factual/compliance errors), Critical Thinking & Proactiveness, Australian Cultural Fit, Resolution & Ownership, and Closing — each scored 1-5 (1=Absent, 5=Exemplary), weighted into an overall percentage. A great call is warm and locally natural, listens without interrupting, is 100% accurate on compliance details, proactively solves problems, and fully resolves the reason for the call.

This report's focus: ${focusLabel}.

Aggregate data for the period:
- Calls evaluated: ${stats.total}
- Average overall score: ${stats.avgOverallScore}%
- Outcomes: ${stats.outcomeBreakdown.pass || 0} pass, ${stats.outcomeBreakdown.coaching || 0} coaching recommended, ${stats.outcomeBreakdown.escalate || 0} escalate

Category averages (out of 5):
${categoryAvgLines}

Per-rep summary:
${perRepLines}

Highest-scoring examples this period (evaluator notes):
${topLines}

Lowest-scoring examples this period (evaluator notes):
${bottomLines}

Write a report with:
1. A team-level summary (3-5 sentences) of how calls performed against the rubric standards this period.
2. Per-rep notes — for each rep with at least 2 calls evaluated, 2-3 sentences on their specific patterns (strengths and growth areas), grounded in the data above. Skip reps with only 1 call.
3. Outliers — specific, concerning patterns worth addressing (e.g. a rep repeatedly weak in one category, a compliance failure, a sharp drop in quality). Reference specific evidence from the notes above. If there genuinely are none, return an empty array.
4. Commendations — specific, genuinely excellent behaviours worth recognising, referencing specific evidence from the notes above. If there genuinely are none, return an empty array.

Respond with ONLY valid JSON, no other text:
{"teamSummary": string, "perRep": [{"repName": string, "summary": string}], "outliers": [{"repName": string or null, "issue": string, "evidence": string}], "commendations": [{"repName": string or null, "behavior": string, "evidence": string}]}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 3000,
    system,
    messages: [{ role: 'user', content: 'Generate the report.' }]
  });

  // Find the actual text block — some models can emit a thinking block first,
  // which would otherwise silently parse as "{}" and look like an empty report.
  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock?.text || '{}';
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    throw new Error('Could not parse the AI report response');
  }

  return { stats, aiReport: parsed };
}

module.exports = { generateReport };
