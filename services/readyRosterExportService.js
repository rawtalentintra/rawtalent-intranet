// Ready-to-roster export (Joy, 21 Oct 2026). Micropods → "Export ready-to-roster
// list": pick a state, HeartBeat re-checks every Active educator in that state
// LIVE with RT (by id, not the nightly copy), then builds the same workbook Joy
// used for SA/VIC/QLD/NT by hand: the audited list, a Map picture, Area summary,
// everyone excluded with the reason, and how it was audited, plus an
// interactive map. Same compliance rule as Micropods
// (services/educatorComplianceService.js). Reads RT only; fresh records are
// written back to our own rt_candidates_cache.
const sharp = require('sharp');
const ExcelJS = require('exceljs');
const { getDb } = require('../db/database');
const { complianceReasons } = require('./educatorComplianceService');
const { fetchCandidatesLive } = require('./rtCandidatesSyncService');
const { normalizeStateToShort } = require('./micropodService');

const PALETTE = ['#2b8a3e', '#1c7ed6', '#d9480f', '#7048e8', '#0c8599', '#e64980', '#f08c00', '#495057'];
const NO_ADDRESS = 'No mappable address';
const STATE_BOX = { VIC: [-39.3, -33.9, 140.8, 150.1], SA: [-38.2, -25.9, 128.9, 141.1], QLD: [-29.3, -9, 137.9, 154], NT: [-26.1, -10.9, 128.9, 138.1],
  NSW: [-37.6, -28.1, 140.9, 153.7], ACT: [-35.95, -35.1, 148.7, 149.45], WA: [-35.2, -13.6, 112.9, 129.1], TAS: [-43.7, -39.5, 143.8, 148.5] };
const CAPITAL = { VIC: [-37.8136, 144.9631, 'Melbourne'], SA: [-34.9285, 138.6007, 'Adelaide'], QLD: [-27.4698, 153.0251, 'Brisbane'], NT: [-12.4634, 130.8456, 'Darwin'],
  NSW: [-33.8688, 151.2093, 'Sydney'], ACT: [-35.2809, 149.13, 'Canberra'], WA: [-31.9523, 115.8613, 'Perth'], TAS: [-42.8821, 147.3272, 'Hobart'] };
const PROFILE = id => `https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${id}`;

function distBearing(lat, lng, [clat, clng]) {
  const dy = (lat - clat) * 111, dx = (lng - clng) * 111 * Math.cos(clat * Math.PI / 180);
  return { d: Math.hypot(dx, dy), b: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
}
// Areas follow the hand-built 12/19 Oct files: inner ring around the capital,
// then direction, with named regions where the state has an obvious one.
function areaFor(state, lat, lng) {
  const box = STATE_BOX[state];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0) || (box && !(lat > box[0] && lat < box[1] && lng > box[2] && lng < box[3]))) return NO_ADDRESS;
  const cap = CAPITAL[state];
  const { d, b } = distBearing(lat, lng, cap);
  if (state === 'VIC') {
    if (lat > -38.4 && lat < -37.9 && lng > 144.1 && lng < 144.75) return 'Geelong & Surf Coast';
    if (d > 70) return 'Regional Victoria';
    if (d < 8) return 'Inner Melbourne';
    if (b < 60 || b >= 330) return 'Northern Melbourne';
    if (b < 115) return 'Eastern Melbourne';
    if (b < 160) return 'South-Eastern Melbourne';
    if (b < 220) return 'Bayside & Mornington';
    return 'Western Melbourne';
  }
  if (state === 'SA') {
    if (d > 90) return 'Regional SA';
    if (lat > -34.705) return 'Gawler, Barossa & Mid North';
    if (lng > 138.72 && lat < -34.85) return 'Adelaide Hills & Mt Barker';
    if (lat < -35.015) return 'Southern Adelaide';
    if (lat > -34.86 && d >= 8) return 'Northern Adelaide';
    return 'Central Adelaide';
  }
  if (state === 'QLD') {
    if (lat < -27.75 && lng > 153.15) return 'Gold Coast';
    if (lat > -27.0 && lat < -26.2 && lng > 152.85) return 'Sunshine Coast & Moreton North';
    if (d > 70) return 'Regional Queensland';
    if (d < 8) return 'Inner Brisbane';
    if (lng < 152.85) return 'Ipswich & Western Brisbane';
    return (b < 90 || b >= 300) ? 'Northern Brisbane & Moreton Bay' : (b < 240 ? 'Logan & Southern Brisbane' : 'Ipswich & Western Brisbane');
  }
  if (state === 'NT') return lat > -12.8 ? 'Darwin & Palmerston' : (lat < -23 ? 'Alice Springs' : 'Regional NT');
  const city = cap[2];
  if (d > 70) return `Regional ${state}`;
  if (d < 8) return `Inner ${city}`;
  return `${b < 45 || b >= 315 ? 'Northern' : b < 135 ? 'Eastern' : b < 225 ? 'Southern' : 'Western'} ${city}`;
}

const shortState = s => normalizeStateToShort(s) || String(s || '').trim().toUpperCase() || null;
const homeAddress = c => {
  const addrs = (c.addresses || []).filter(a => !a.isDeleted && a.isActive !== false);
  return addrs.find(x => x.addressTypeId === 1) || addrs[0] || {};
};
const latestReviewedExpiry = (docs, re) => (docs || [])
  .filter(d => !d.isDeleted && d.isActive !== false && d.isReviewed && re.test(d.requirementName || ''))
  .map(d => String(d.expiryDate || '').slice(0, 10)).filter(x => x && x !== '0001-01-01').sort().pop() || '';
const WWC_RE = /blue card|working with (children|vulnerable)|\bwwc/i;
const FA_RE = /first aid/i;
const CS_RE = /protecting children|foundations of child safety|ec-protect|rran|\bran\b/i;

// ── Map picture: Esri street tiles stitched with sharp, dots + legend as SVG ──
function px(lat, lng, z) {
  const n = 256 * 2 ** z, r = lat * Math.PI / 180;
  return [(lng + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function renderMapPng(marks, legend, title, W = 1400, H = 1100) {
  const lats = marks.map(m => m.lat), lngs = marks.map(m => m.lng);
  let z = 14, x0, x1, y0, y1;
  for (; z > 3; z--) {
    [x0, y1] = px(Math.min(...lats), Math.min(...lngs), z); [x1, y0] = px(Math.max(...lats), Math.max(...lngs), z);
    if (x1 - x0 < W * 0.8 && y1 - y0 < (H - 160) * 0.8) break;
  }
  const ox = (x0 + x1) / 2 - W / 2, oy = (y0 + y1) / 2 - H / 2 + 40;
  const tiles = [];
  for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W) / 256); tx++) {
    for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H) / 256); ty++) tiles.push([tx, ty]);
  }
  const composites = [];
  await Promise.all(tiles.map(async ([tx, ty]) => {
    try {
      const r = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${ty}/${tx}`, { headers: { 'User-Agent': 'RawTalent-HeartBeat/1.0' } });
      if (!r.ok) return;
      let buf = Buffer.from(await r.arrayBuffer());
      let left = Math.round(tx * 256 - ox), top = Math.round(ty * 256 - oy);
      // sharp won't composite outside the canvas, so crop edge tiles first
      const cl = Math.max(0, -left), ct = Math.max(0, -top);
      const cw = Math.min(256 - cl, W - Math.max(left, 0)), ch = Math.min(256 - ct, H - Math.max(top, 0));
      if (cw <= 0 || ch <= 0) return;
      buf = await sharp(buf).extract({ left: cl, top: ct, width: cw, height: ch }).png().toBuffer();
      composites.push({ input: buf, left: Math.max(left, 0), top: Math.max(top, 0) });
    } catch { /* missing tile = blank patch */ }
  }));
  const dots = marks.slice().sort((a, b) => b.people.length - a.people.length).map(m => {
    const [x, y] = px(m.lat, m.lng, z), r = 6 + 3 * Math.sqrt(m.people.length);
    return `<circle cx="${(x - ox).toFixed(1)}" cy="${(y - oy).toFixed(1)}" r="${r.toFixed(1)}" fill="${m.color}" fill-opacity="0.6" stroke="${m.color}" stroke-width="2"/>`;
  }).join('');
  const bw = 560, bh = 54 + 30 * legend.length;
  const leg = `<rect x="${W - bw - 15}" y="15" width="${bw}" height="${bh}" fill="#fff" fill-opacity="0.93" stroke="#bbb"/>
    <text x="${W - bw}" y="44" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="bold">${xmlEsc(title)}</text>` +
    legend.map(([c, l], i) => `<circle cx="${W - bw + 8}" cy="${68 + i * 30}" r="8" fill="${c}"/><text x="${W - bw + 26}" y="${74 + i * 30}" font-family="Helvetica, Arial, sans-serif" font-size="18">${xmlEsc(l)}</text>`).join('');
  const foot = `<rect x="0" y="${H - 34}" width="${W}" height="34" fill="#fff" fill-opacity="0.85"/><text x="10" y="${H - 11}" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#333">Map tiles © Esri. Dot size = educators in that suburb.</text>`;
  composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${dots}${leg}${foot}</svg>`), left: 0, top: 0 });
  return sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite(composites).png().toBuffer();
}

function mapHtml(state, marks, legend, total, today) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeMarks = marks.map(m => ({ ...m, suburb: esc(m.suburb || ''), people: m.people.map(esc) }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${state} audited educators map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css">
<style>html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#fff}#map{height:100%}
.legend{position:absolute;z-index:1000;top:12px;right:12px;background:#fff;padding:10px 12px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.25);font-size:13px;max-width:300px}
.legend b{display:block;margin-bottom:6px}.legend span{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:7px}</style></head>
<body><div id="map"></div>
<div class="legend"><b>${state} — audited &amp; ready to roster (${total})</b>${legend.map(([c, l]) => `<div><span style="background:${c}"></span>${esc(l)}</div>`).join('')}<div style="margin-top:6px;color:#555">Active, onboarding complete, all documents reviewed and in date (live RT check ${today}). Dot size = educators in that suburb. Click a dot for names.</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<script>
const marks=${JSON.stringify(safeMarks).replace(/</g, '\\u003c')};
const map=L.map('map').setView([${CAPITAL[state] ? CAPITAL[state][0] : -27}, ${CAPITAL[state] ? CAPITAL[state][1] : 134}],10);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',{attribution:'Tiles © Esri',maxZoom:19}).addTo(map);
const b=[];
marks.forEach(m=>{const r=6+Math.min(m.people.length,12)*1.6;
 L.circleMarker([m.lat,m.lng],{radius:r,color:m.color,fillColor:m.color,fillOpacity:.55,weight:2}).addTo(map)
  .bindPopup('<b>'+m.suburb+'</b> — '+m.people.length+' ready<br>'+m.people.join('<br>'));b.push([m.lat,m.lng]);});
if(b.length)map.fitBounds(b,{padding:[30,30]});
</script></body></html>`;
}

// ── The export itself ─────────────────────────────────────────────────────
async function buildReadyRosterExport(state, { onProgress } = {}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
  // Everyone the cache has as Active with a home address in this state. The
  // stale-row refresh keeps this list itself current; each person is then
  // re-checked live below.
  const rows = (await getDb().execute({
    sql: `SELECT user_id, raw->'addresses' addrs FROM rt_candidates_cache WHERE is_deleted IS NOT TRUE AND status = 1`, args: []
  })).rows;
  const ids = rows.filter(r => {
    const addrs = (r.addrs || []).filter(a => !a.isDeleted && a.isActive !== false);
    const a = addrs.find(x => x.addressTypeId === 1) || addrs[0] || {};
    return shortState(a.state) === state;
  }).map(r => r.user_id);
  onProgress && onProgress({ phase: 'checking', done: 0, total: ids.length });
  const { candidates, failed } = await fetchCandidatesLive(ids, { onProgress: (done, total) => onProgress && onProgress({ phase: 'checking', done, total }) });
  onProgress && onProgress({ phase: 'building', done: ids.length, total: ids.length });

  const bridge = require('./cioOnboardingBridgeService');
  const cioMap = await bridge.bridgeMap();
  const ok = [], excluded = [], reasonCount = {};
  for (const c of candidates) {
    const a = homeAddress(c);
    const docs = c.attachedRequirements || [];
    const p = {
      id: c.userId, name: `${c.firstName || ''} ${c.lastName || ''}`.trim(), phone: c.contactNo || '', email: c.email || '',
      suburb: a.suburb || '', postcode: a.postCode || a.postcode || '', lat: Number(a.latitude), lng: Number(a.longitude),
      qual: (c.qualifications || [])[0]?.qualificationName || '',
      wwc: latestReviewedExpiry(docs, WWC_RE), fa: latestReviewedExpiry(docs, FA_RE), cs: latestReviewedExpiry(docs, CS_RE)
    };
    p.area = areaFor(state, p.lat, p.lng);
    let why = null;
    if (c.isDeleted || c.status !== 1) why = 'No longer Active in RT';
    else if (!bridge.onboardingCompleted(c.userId, c.obStatus, cioMap)) why = c.obStatus != null ? `Onboarding not Completed (${c.obStatus})` : 'Onboarding not Completed (Customer.io)';
    else if (shortState(a.state) !== state) why = `Home address now in ${shortState(a.state) || 'another state'}`;
    else {
      const r = complianceReasons(c, today, c.userId);
      if (r.length) why = r.join('; ');
      r.forEach(x => { const k = x.replace(/ expired \d{4}-\d{2}-\d{2}/, ' expired').replace(/^.*?(Visa) expired.*/, 'Visa expired'); reasonCount[k] = (reasonCount[k] || 0) + 1; });
    }
    (why ? excluded : ok).push(why ? { ...p, why } : p);
  }

  const counts = {}; ok.forEach(p => { counts[p.area] = (counts[p.area] || 0) + 1; });
  const order = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([a]) => a);
  const color = {}; order.filter(a => a !== NO_ADDRESS).forEach((a, i) => { color[a] = PALETTE[i % PALETTE.length]; }); color[NO_ADDRESS] = '#adb5bd';
  ok.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area) || a.suburb.localeCompare(b.suburb) || a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  const legend = order.map(a => [color[a], `${a} — ${counts[a]}`]);

  const groups = new Map();
  for (const p of ok) {
    if (p.area === NO_ADDRESS) continue;
    const k = `${p.lat.toFixed(2)}|${p.lng.toFixed(2)}|${p.suburb}|${p.area}`;
    if (!groups.has(k)) groups.set(k, { lat: +p.lat.toFixed(2), lng: +p.lng.toFixed(2), suburb: p.suburb, area: p.area, color: color[p.area], people: [] });
    groups.get(k).people.push(`${p.name}${p.qual ? ` (${p.qual})` : ''}`);
  }
  const marks = [...groups.values()];

  // Workbook
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RawTalent HeartBeat';
  const header = (ws, cols) => {
    ws.columns = cols.map(([h, w]) => ({ header: h, width: w }));
    ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } }; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const base = [['Area', 24], ['Name', 28], ['Phone', 15], ['Email', 34], ['Suburb', 20], ['Postcode', 9], ['Qualification', 26]];
  const docsCols = [['WWC / Blue Card valid to', 14], ['First Aid (RT expiry)', 14], ['Child safety training (valid to)', 16], ['RT Profile Link', 60]];
  const list = wb.addWorksheet(`${state} audited list`);
  header(list, [...base, ['Compliance audited?', 30], ['Audit date', 11], ...docsCols]);
  ok.forEach(p => list.addRow([p.area, p.name, p.phone, p.email, p.suburb, p.postcode, p.qual, 'Yes - live RT check, all core documents reviewed & in date', today, p.wwc, p.fa, p.cs, { text: PROFILE(p.id), hyperlink: PROFILE(p.id) }]));
  if (!ok.length) list.addRow([`No ${state} educators pass the audit as of ${today}. See "Excluded (all)".`]);
  if (ok.length) list.autoFilter = { from: 'A1', to: 'M1' };

  let png = null;
  if (marks.length) {
    png = await renderMapPng(marks, legend, `${state} — audited, ready to roster (${ok.length})`);
    const m = wb.addWorksheet('Map');
    m.getCell('A1').value = `${state} audited educators — ${ok.length} people, plotted by home suburb. Interactive version: the HTML map downloaded with this file.`;
    m.getCell('A1').font = { bold: true };
    m.addImage(wb.addImage({ buffer: png, extension: 'png' }), { tl: { col: 0, row: 2 }, ext: { width: 1050, height: 825 } });
    // Legend repeated in cells beside the picture, so it reads even if the
    // server has no fonts for the picture's own text.
    m.getCell('S3').value = 'Area'; m.getCell('T3').value = 'Educators';
    m.getCell('S3').font = m.getCell('T3').font = { bold: true };
    order.forEach((a, i) => {
      const c = m.getCell(`S${4 + i}`); c.value = a;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color[a].slice(1).toUpperCase() } };
      c.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      m.getCell(`T${4 + i}`).value = counts[a];
    });
    m.getColumn('S').width = 32;
  }

  const sum = wb.addWorksheet('Area summary');
  header(sum, [['Area', 30], ['Educators', 11], ['Top suburbs', 100]]);
  order.forEach(a => {
    const sub = {}; ok.filter(p => p.area === a).forEach(p => { sub[p.suburb || '—'] = (sub[p.suburb || '—'] || 0) + 1; });
    sum.addRow([a, counts[a], Object.entries(sub).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([s, n]) => `${s} (${n})`).join(', ')]);
  });

  const ex = wb.addWorksheet('Excluded (all)');
  header(ex, [...base, ['Why not on the list', 70], ...docsCols]);
  excluded.forEach(p => ex.addRow([p.area, p.name, p.phone, p.email, p.suburb, p.postcode, p.qual, p.why, p.wwc, p.fa, p.cs, { text: PROFILE(p.id), hyperlink: PROFILE(p.id) }]));

  const topReasons = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(', ');
  const how = wb.addWorksheet('How this was audited');
  how.getColumn(1).width = 150;
  [
    `Scope: ${state} educators (home address in ${state}), Active in RT with onboarding Completed.`,
    `Every person (${ids.length} Active ${state} educators) was re-fetched LIVE from RT on ${today}, not from HeartBeat's overnight copy.${failed.length ? ` ${failed.length} could not be fetched from RT and are not included.` : ''}`,
    'Rule (same as Micropods): the newest copy of every document on file must be reviewed and in date; must hold ID, First Aid, Working with Children (Blue Card in QLD), Foundations of Child Safety (or RAN / Protecting Children) and a reviewed qualification. Advanced Child Safety alone does not count. A non-citizen visa must not be expired. A police check is not required, but if one is on file it must be in date.',
    `Result: ${ok.length} pass, ${excluded.length} excluded (each with the reason on the "Excluded (all)" tab).`,
    topReasons ? `Most common reasons: ${topReasons}.` : '',
    'Open question: RT tracks First Aid as valid for 3 years, but CPR (HLTAID009) is only valid for 12 months. Not applied here.',
    'Areas are worked out from each home address (distance and direction from the capital, plus named regions).',
    'Generated by HeartBeat → Micropods → Export ready-to-roster list.'
  ].filter(Boolean).forEach(t => how.addRow([t]));

  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  const html = marks.length ? mapHtml(state, marks, legend, ok.length, today) : null;
  return { state, date: today, checked: ids.length, failed: failed.length, ready: ok.length, excluded: excluded.length, areas: legend.map(l => l[1]), xlsx, html };
}

module.exports = { buildReadyRosterExport, areaFor };
