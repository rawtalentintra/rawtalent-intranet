// Best-effort extraction of a real-world date/time from a transcript's
// text content, so a recording attached to a centre can be recognized as
// happening on the date it actually happened, not just whenever it was
// uploaded. Deliberately conservative — returns null rather than guessing
// when nothing lines up confidently, since a wrong date silently attached
// to a centre's contact history is worse than no date at all (same
// posture as leadAutoSignService's predate-grace check).
//
// Dates are built manually from named capture groups rather than handed
// to `new Date(matchedString)` — the native parser only reliably handles
// ISO and "Month D, YYYY" ordering; "D Month YYYY" and DD/MM/YYYY (the
// ordering RawTalent's own data uses throughout, being AU-based — see
// centreMatchService's STATE_FULL_TO_SHORT) both come back Invalid Date
// from it (confirmed directly: `new Date('10 August 2026')` and
// `new Date('15/03/2026')` are both NaN).

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

// A bare date mentioned mid-conversation ("we spoke on the 5th") is far
// less reliable than one sitting next to a header keyword — most
// transcript exports (Zoom/Teams/Otter.ai) put the real session date in a
// line like "Meeting started: ..." or "Call recorded on ...".
const CONTEXT_KEYWORDS = /\b(start|started|call|meeting|record|recorded|recording|visit|date|session|transcript)\b/i;

function hour24(hourStr, meridiem) {
  let h = parseInt(hourStr, 10);
  if (!meridiem) return h;
  const m = meridiem.toLowerCase();
  if (m === 'am') return h === 12 ? 0 : h;
  return h === 12 ? 12 : h + 12;
}

function isPlausible(date) {
  if (!date || isNaN(date.getTime())) return false;
  const now = Date.now();
  const fiveYearsAgo = now - 5 * 365 * 24 * 60 * 60 * 1000;
  const oneDayAhead = now + 24 * 60 * 60 * 1000;
  return date.getTime() >= fiveYearsAgo && date.getTime() <= oneDayAhead;
}

// Each entry: a regex with named groups, and a builder that turns those
// groups into a Date (or null if the groups don't make sense, e.g. month
// > 12 for the slash-date pattern).
const PATTERNS = [
  {
    // ISO: 2026-03-05T10:32:00 or 2026-03-05 10:32
    re: /\b(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})[T ](?<h>\d{1,2}):(?<mi>\d{2})(?::\d{2})?\b/gi,
    build: g => new Date(Number(g.y), Number(g.mo) - 1, Number(g.d), Number(g.h), Number(g.mi))
  },
  {
    // "March 5, 2026 10:32 AM" / "Mar 5 2026"
    re: new RegExp(`\\b(?<mo>${MONTH_NAMES})\\.?\\s+(?<d>\\d{1,2}),?\\s+(?<y>\\d{4})(?:,?\\s+(?<h>\\d{1,2}):(?<mi>\\d{2})(?::\\d{2})?\\s*(?<ap>am|pm)?)?\\b`, 'gi'),
    build: g => {
      const mo = MONTHS[g.mo.toLowerCase()];
      if (mo === undefined) return null;
      return new Date(Number(g.y), mo, Number(g.d), g.h ? hour24(g.h, g.ap) : 0, g.h ? Number(g.mi) : 0);
    }
  },
  {
    // "5 March 2026, 10:32am"
    re: new RegExp(`\\b(?<d>\\d{1,2})\\s+(?<mo>${MONTH_NAMES})\\.?,?\\s+(?<y>\\d{4})(?:,?\\s+(?<h>\\d{1,2}):(?<mi>\\d{2})(?::\\d{2})?\\s*(?<ap>am|pm)?)?\\b`, 'gi'),
    build: g => {
      const mo = MONTHS[g.mo.toLowerCase()];
      if (mo === undefined) return null;
      return new Date(Number(g.y), mo, Number(g.d), g.h ? hour24(g.h, g.ap) : 0, g.h ? Number(g.mi) : 0);
    }
  },
  {
    // DD/MM/YYYY or DD-MM-YYYY (AU order), optionally with a time
    re: /\b(?<d>\d{1,2})[/-](?<mo>\d{1,2})[/-](?<y>\d{2,4})(?:,?\s+(?<h>\d{1,2}):(?<mi>\d{2})(?::\d{2})?\s*(?<ap>am|pm)?)?\b/gi,
    build: g => {
      const day = Number(g.d), mo = Number(g.mo);
      if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
      let year = Number(g.y);
      if (year < 100) year += year < 70 ? 2000 : 1900;
      return new Date(year, mo - 1, day, g.h ? hour24(g.h, g.ap) : 0, g.h ? Number(g.mi) : 0);
    }
  }
];

function detectTimestampFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const candidates = [];
  for (const { re, build } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const date = build(match.groups || {});
      if (isPlausible(date)) {
        const contextStart = Math.max(0, match.index - 60);
        const contextEnd = Math.min(text.length, match.index + match[0].length + 20);
        const hasContext = CONTEXT_KEYWORDS.test(text.slice(contextStart, contextEnd));
        candidates.push({ date, index: match.index, hasContext });
      }
      if (match[0].length === 0) re.lastIndex++;
    }
  }
  if (!candidates.length) return null;

  const withContext = candidates.filter(c => c.hasContext).sort((a, b) => a.index - b.index);
  const chosen = withContext[0] || candidates.slice().sort((a, b) => a.index - b.index)[0];
  return chosen.date.toISOString();
}

module.exports = { detectTimestampFromText };
