// Educator Texts (Joy, 24 Nov 2026) — main app tab ?tab=texts.
// Inbox of SMS conversations with educators + a "New text" builder with
// RT-accurate filters (same data as the Educator Map) and a centre/radius
// filter. Sends go through Customer.io (routes/educatorTexts.js).
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, opts) => { const r = await fetch(url, opts); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; };
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const say = (m, t) => (window.toast ? window.toast(m, t) : alert(m));

  // Same segment maths as the server (services/educatorTextService.js).
  const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  const smart = t => String(t || '').replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—‒−]/g, '-').replace(/…/g, '...').replace(/ /g, ' ');
  function seg(text) {
    const t = smart(text); let u = 0;
    for (const ch of t) { if (GSM.includes(ch)) u++; else if ('^{}\\[~]|€'.includes(ch)) u += 2; else { const n = [...t].length; return { enc: 'UCS-2', n, s: n <= 70 ? 1 : Math.ceil(n / 67), max: n <= 70 ? 70 : Math.ceil(n / 67) * 67 }; } }
    return { enc: 'GSM-7', n: u, s: u <= 160 ? 1 : Math.ceil(u / 153), max: u <= 160 ? 160 : Math.ceil(u / 153) * 153 };
  }
  const km = (a, b, c, d) => { const R = 6371, r = x => x * Math.PI / 180, dl = r(c - a), dg = r(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const ago = iso => { if (!iso) return ''; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  const when = iso => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  const SEG = { actively_working: 'Actively Working', actively_engaged: 'Actively Engaged', engaged: 'Engaged', disengaged: 'Disengaged', dormant: 'Dormant' };
  const S = { view: 'inbox', usage: null, aud: null, convos: [], open: null, thread: [], maxId: 0, settled: 0, poll: null,
    f: { status: new Set(['Active']), state: new Set(), onboarding: new Set(), compliance: 'any', gender: new Set(), qual: new Set(), segment: new Set(),
         centre: '', radius: 15, avail: false, worked28: false, notTextedDays: 7, replied: 'any', search: '',
         cstate: new Set(), booking: new Set(), mobileOnly: true },
    numbers: [], picked: null, body: '', kind: 'educators', audC: null, pinned: new Set(), tableQ: '', lookQ: '' };

  const css = `<style>
    .tx-wrap{max-width:1200px;margin:0 auto}
    .tx-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid var(--gray-100);border-radius:12px;padding:12px 16px;margin-bottom:14px;font-size:13px}
    .tx-pill{background:#f1f5f9;border-radius:999px;padding:4px 10px;font-weight:600;color:var(--navy)}
    .tx-pill.warn{background:#fef3c7;color:#92400e}
    .tx-switch button{border:1px solid var(--gray-200);background:#fff;padding:7px 16px;font-weight:600;cursor:pointer;font-family:inherit;font-size:13px}
    .tx-switch button:first-child{border-radius:8px 0 0 8px}.tx-switch button:last-child{border-radius:0 8px 8px 0}
    .tx-switch button.on{background:var(--navy);color:#fff;border-color:var(--navy)}
    .tx-grid{display:grid;grid-template-columns:320px 1fr;gap:14px;min-height:520px}
    .tx-card{background:#fff;border:1px solid var(--gray-100);border-radius:12px;overflow:hidden}
    .tx-list{max-height:620px;overflow:auto}
    .tx-row{padding:12px 14px;border-bottom:1px solid var(--gray-100);cursor:pointer}
    .tx-row:hover,.tx-row.on{background:#f8fafc}
    .tx-name{font-weight:700;color:var(--navy);font-size:13.5px;display:flex;justify-content:space-between;gap:8px}
    .tx-snip{font-size:12.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
    .tx-badge{background:#2563eb;color:#fff;border-radius:999px;font-size:11px;padding:1px 7px}
    .tx-thread{display:flex;flex-direction:column;height:620px}
    .tx-msgs{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:#f8fafc}
    .tx-b{max-width:72%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.4;white-space:pre-wrap}
    .tx-b.out{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}
    .tx-b.in{align-self:flex-start;background:#fff;border:1px solid var(--gray-200);border-bottom-left-radius:4px}
    .tx-meta{font-size:10.5px;opacity:.75;margin-top:4px}
    .tx-compose{border-top:1px solid var(--gray-100);padding:10px;display:flex;flex-direction:column;gap:6px}
    .tx-compose textarea{width:100%;min-height:64px;resize:vertical;border:1px solid var(--gray-200);border-radius:8px;padding:8px;font-family:inherit;font-size:13.5px}
    .tx-count{font-size:11.5px;color:var(--text-muted);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .tx-count.bad{color:#b45309;font-weight:600}
    .tx-filters{padding:14px;display:flex;flex-direction:column;gap:12px;max-height:760px;overflow:auto}
    .tx-f label.h{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);display:block;margin-bottom:5px}
    .tx-chips{display:flex;flex-wrap:wrap;gap:5px}
    .tx-chip{border:1px solid var(--gray-200);background:#fff;border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
    .tx-chip.on{background:var(--navy);border-color:var(--navy);color:#fff}
    .tx-f select,.tx-f input[type=number],.tx-f input[type=text]{width:100%;border:1px solid var(--gray-200);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:13px}
    .tx-table{width:100%;border-collapse:collapse;font-size:12.5px}
    .tx-table th{position:sticky;top:0;background:#fff;text-align:left;padding:8px;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--gray-200)}
    .tx-table td{padding:7px 8px;border-bottom:1px solid var(--gray-100)}
    .tx-ok{color:#15803d;font-weight:600}.tx-no{color:#b91c1c;font-weight:600}
    @media (max-width:860px){.tx-grid{grid-template-columns:1fr}}
  </style>`;

  async function loadUsage() { try { S.usage = await api('/api/educator-texts/usage'); } catch { S.usage = null; } }
  function usageBar() {
    const u = S.usage; if (!u) return '';
    const left = Math.max(0, u.dailyLimit - u.usedToday);
    return `<div class="tx-bar">
      <div class="tx-switch"><button class="${S.view === 'inbox' ? 'on' : ''}" onclick="txView('inbox')">💬 Inbox</button><button class="${S.view === 'new' ? 'on' : ''}" onclick="txView('new')">✉️ New text</button></div>
      <span class="tx-pill ${left < 30 ? 'warn' : ''}" title="Each SMS is billed per 160-character segment">${u.usedToday} / ${u.dailyLimit} segments used today</span>
      <span class="tx-pill" title="Estimated at $${u.costPerSegmentAud.toFixed(2)} per segment; Twilio's bill is the final figure">💲 Spent today $${u.spend.todayMine.toFixed(2)} (team $${u.spend.todayTeam.toFixed(2)}) · this month $${u.spend.monthMine.toFixed(2)} (team $${u.spend.monthTeam.toFixed(2)})</span>
      ${u.inSendWindow ? '' : '<span class="tx-pill warn">Outside 8am-8pm: texts wait until morning</span>'}
      <span style="color:var(--text-muted);font-size:12px">Educators texted in the last ${u.cooldownHours}h are skipped unless they replied. STOP replies opt them out automatically.</span>
    </div>`;
  }

  // ── Inbox ──
  async function loadConvos() { S.convos = await api('/api/educator-texts/conversations'); }
  function inboxHtml() {
    const rows = S.convos.map(c => `<div class="tx-row ${S.open === c.educator_id ? 'on' : ''}" onclick="txOpen('${esc(c.educator_id)}')">
        <div class="tx-name"><span>${esc(c.educator_name || 'Educator #' + c.educator_id)}</span><span style="font-weight:400;font-size:11.5px;color:var(--text-muted)">${Number(c.unread) ? `<span class="tx-badge">${c.unread}</span> ` : ''}${ago(c.created_at)}</span></div>
        <div class="tx-snip">${c.direction === 'out' ? 'You: ' : ''}${esc(c.body)}</div></div>`).join('');
    const conv = S.convos.find(c => c.educator_id === S.open);
    return `<div class="tx-grid">
      <div class="tx-card tx-list">${rows || '<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px">No texts yet. Start one from "New text".</div>'}</div>
      <div class="tx-card">${S.open ? threadHtml(conv) : '<div style="padding:60px;text-align:center;color:var(--text-muted)">Pick a conversation</div>'}</div></div>`;
  }
  function threadHtml(conv) {
    const msgs = S.thread.map(m => `<div class="tx-b ${m.direction}">${esc(m.body)}<div class="tx-meta">${when(m.created_at)}${m.direction === 'out' ? ` · ${esc(m.sent_by_name || '')} · ${m.status === 'sent' ? 'Sent' : m.status === 'failed' ? '⚠️ Failed: ' + esc(m.error || '') : m.status === 'skipped' ? '⏭ Not sent: ' + esc(m.error || '') : 'Sending…'}` : ''}</div></div>`).join('');
    return `<div class="tx-thread">
      <div style="padding:12px 16px;border-bottom:1px solid var(--gray-100);display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:700;color:var(--navy)">${esc(conv?.educator_name || 'Educator')}</div>
        ${/^(loc|client):/.test(S.open) ? '<span style="font-size:12px;color:var(--text-muted)">Centre</span>' : /^tel:/.test(S.open) ? '<span style="font-size:12px;color:var(--text-muted)">Not in RT</span>' : `<a href="https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${encodeURIComponent(S.open)}" target="_blank" rel="noopener" style="font-size:12px;color:#2563eb">Open in RT Portal ↗</a>`}</div>
      <div class="tx-msgs" id="txMsgs">${msgs}</div>
      <div class="tx-compose"><textarea id="txReply" placeholder="Write a reply…" oninput="txCount('txReply','txReplyCount')"></textarea>
        <div class="tx-count" id="txReplyCount"></div>
        <div style="display:flex;justify-content:flex-end"><button class="btn-add" onclick="txReply()">Send</button></div></div></div>`;
  }
  window.txOpen = async id => {
    S.open = id; S.thread = await api(`/api/educator-texts/conversations/${encodeURIComponent(id)}`);
    const c = S.convos.find(x => x.educator_id === id); if (c) c.unread = 0;
    render(); const m = document.getElementById('txMsgs'); if (m) m.scrollTop = m.scrollHeight;
  };
  window.txReply = async () => {
    const el = document.getElementById('txReply'); const body = el.value.trim(); if (!body) return;
    try {
      const r = await post('/api/educator-texts/send', { userIds: [S.open], body, ignoreCooldown: true, audienceNote: 'Reply' });
      if (!r.queued) return say(r.skipped?.[0]?.why || 'Not sent', 'error');
      el.value = ''; await Promise.all([loadUsage(), loadConvos()]); await txOpen(S.open);
    } catch (e) { say(e.message, 'error'); }
  };
  window.txCount = (taId, outId) => {
    const t = document.getElementById(taId)?.value || '', out = document.getElementById(outId); if (!out) return;
    const x = seg(t.replace(/\{first_name\}/gi, 'Bartholomew'));
    out.className = 'tx-count' + (x.s > 1 || x.enc !== 'GSM-7' ? ' bad' : '');
    out.innerHTML = `<span>${x.n}/${x.max} characters · ${x.s} segment${x.s > 1 ? 's' : ''} per text${x.enc !== 'GSM-7' ? ' · emoji/special characters cut the limit to 70' : ''}</span>${x.s > 1 ? '<span>Shorten to 1 segment to halve the cost</span>' : ''}`;
  };

  // ── New text ──
  // ── Phone / name matching (04xx, 4xx, +61 4xx, with or without spaces) ──
  const nd = s => { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('61')) d = d.slice(2); return d.replace(/^0+/, ''); };
  function matches(e, q) {
    q = String(q || '').trim(); if (!q) return true;
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3) {
      const qd = nd(q);
      if ([e.phone, ...(e.allPhones || [])].some(p => p && nd(p).includes(qd))) return true;
    }
    const hay = [e.name, e.contactName, e.suburb].filter(Boolean).join(' ').toLowerCase();
    const words = q.toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every(w => hay.includes(w));
  }
  const isC = () => S.kind === 'centres';
  const all = () => (isC() ? (S.audC?.recipients || []) : (S.aud?.educators || []));
  const noun = (n) => isC() ? (n === 1 ? 'centre' : 'centres') : (n === 1 ? 'educator' : 'educators');

  function filtered() {
    const f = S.f, a = S.aud; if (!a || (isC() && !S.audC)) return [];
    const c = f.centre ? a.centres.find(x => x.centreKey === f.centre) : null;
    const notSince = f.notTextedDays ? Date.now() - f.notTextedDays * 864e5 : null;
    const common = e => (!notSince || !e.lastTextAt || new Date(e.lastTextAt).getTime() < notSince) &&
      (f.replied === 'any' || (f.replied === 'yes') === !!e.lastReplyAt) && matches(e, f.search);
    let list = isC()
      ? all().filter(e => (!f.cstate.size || f.cstate.has(e.state || 'Unknown')) && (!f.booking.size || f.booking.has(e.booking)) && (!f.mobileOnly || e.hasMobile) && common(e))
      : all().filter(e =>
        (!f.status.size || f.status.has(e.status)) && (!f.state.size || f.state.has(e.state || 'Unknown')) &&
        (!f.onboarding.size || f.onboarding.has(e.onboarding || 'Not started')) &&
        (f.compliance === 'any' || (f.compliance === 'yes') === !!e.compliant) &&
        (!f.gender.size || f.gender.has(e.gender || 'Unknown')) && (!f.qual.size || f.qual.has(e.qualification || 'Unknown')) &&
        (!f.segment.size || f.segment.has(e.segment)) && (!f.avail || e.availDays > 0) && (!f.worked28 || e.shifts28d > 0) && common(e));
    list = list.map(e => c && e.lat != null ? { ...e, dist: km(c.lat, c.lng, e.lat, e.lng) } : e)
      .filter(e => !c || (e.dist != null && e.dist <= f.radius))
      .sort((x, y) => c ? x.dist - y.dist : (x.name || '').localeCompare(y.name || ''));
    // People added with the lookup always show, at the top, whatever the filters say.
    const pinned = all().filter(e => S.pinned.has(e.userId) && !list.some(x => x.userId === e.userId)).map(e => ({ ...e, pinned: true }));
    return [...S.numbers.filter(n => n.kind === S.kind), ...pinned, ...list];
  }
  const OB_STEPS = ['Register', 'AboutUs', 'Profile Image', 'Experience', 'Emergency Contact', 'Qualification Level', 'Reference', 'Visa', 'Finance', 'Tax', 'Documents', 'Completed'];
  const OB_LABEL = { Register: 'Step 0 · Registered', AboutUs: 'Step 1 · About Us', 'Profile Image': 'Step 2 · Profile Image', Experience: 'Step 3 · Experience', 'Emergency Contact': 'Step 4 · Emergency Contact', 'Qualification Level': 'Step 5 · Qualification Level', Reference: 'Step 6 · Reference', Visa: 'Step 7 · Visa', Finance: 'Step 8 · Finance', Tax: 'Step 9 · Tax', Documents: 'Step 10 · Documents', Completed: '✓ Completed' };
  const obSort = vals => vals.slice().sort((a, b) => ((OB_STEPS.indexOf(a) + 1) || 99) - ((OB_STEPS.indexOf(b) + 1) || 99));
  const opts = key => [...new Set(all().map(e => (key === 'onboarding' ? e.onboarding || 'Not started' : e[key] || 'Unknown')))].sort();
  function chips(name, values, set, label = v => v) {
    return `<div class="tx-chips">${values.map(v => `<button class="tx-chip ${set.has(v) ? 'on' : ''}" onclick="txChip('${name}','${esc(v).replace(/'/g, '&#39;')}')">${esc(label(v))}</button>`).join('')}</div>`;
  }
  window.txChip = (name, v) => { const s = S.f[name]; s.has(v) ? s.delete(v) : s.add(v); renderNew(); };
  window.txSet = (k, v) => { S.f[k] = v; renderNew(); };
  window.txKind = async k => {
    if (S.kind === k) return;
    S.kind = k; S.picked = new Set(); S.pinned = new Set(); S.tableQ = ''; S.lookQ = ''; S.f.search = '';
    renderNew();
    if (k === 'centres' && !S.audC) { try { S.audC = await api('/api/educator-texts/audience?type=centres'); } catch (e) { say(e.message, 'error'); } renderNew(); }
  };

  function rowHtml(e) {
    const box = `<td><input type="checkbox" ${S.picked.has(e.userId) ? 'checked' : ''} ${e.hasMobile ? '' : `disabled title="${isC() ? 'No mobile number (or no RT contact profile)' : 'No valid mobile'}"`} onchange="txPick('${esc(e.userId)}',this.checked)"></td>`;
    const last = `<td>${e.lastTextAt ? ago(e.lastTextAt) + ' ago' : '-'}${e.lastReplyAt ? ' · replied' : ''}</td>`;
    const where = `<td>${esc(e.suburb || '')}${e.state ? ', ' + e.state : ''}${e.dist != null ? `<div style="color:var(--text-muted);font-size:11px">${e.dist.toFixed(1)} km</div>` : ''}</td>`;
    const tag = e.pinned ? ' <span class="tx-pill" style="font-size:10px;padding:1px 6px">added</span>' : '';
    if (e.type === 'number') return `<tr>${box}<td><b>${esc(e.name)}</b> <span class="tx-pill" style="font-size:10px;padding:1px 6px">any number</span><div style="color:var(--text-muted);font-size:11px">${esc(e.phone)}</div></td><td colspan="${isC() ? 3 : 5}" style="color:var(--text-muted);font-size:12px">Matched to an RT ${isC() ? 'centre' : 'educator'} automatically if the number is in RT</td><td><button class="tx-chip" onclick="txRemoveNum('${esc(e.userId)}')">Remove</button></td></tr>`;
    if (isC()) return `<tr>${box}<td><b>${esc(e.name)}</b>${tag}<div style="color:var(--text-muted);font-size:11px">${esc(e.contactName || '')}${e.contactName ? ' · ' : ''}${esc(e.phone || 'no number')}${e.hasMobile ? '' : ' (not a mobile)'}</div></td>${where}<td>${esc(e.booking)}</td><td>${e.lastBooking ? esc(e.lastBooking.split('-').reverse().join('/')) : '-'}</td>${last}</tr>`;
    return `<tr>${box}<td><b>${esc(e.name)}</b>${tag}<div style="color:var(--text-muted);font-size:11px">${esc(e.phone || 'no mobile')}</div></td>${where}
      <td>${esc(e.status || '')}</td><td class="${e.compliant ? 'tx-ok' : 'tx-no'}">${e.compliant ? 'Compliant' : 'Not compliant'}${e.liveAt ? ' <span title="Checked live against RT just now" style="color:#2563eb">●</span>' : ''}</td>
      <td>${esc(SEG[e.segment] || '')}</td><td>${e.availDays ? e.availDays + ' days' : '-'}</td>${last}</tr>`;
  }
  function rowsHtml(list) {
    const shown = list.filter(e => matches(e, S.tableQ));
    const cols = isC() ? 6 : 8;
    return (shown.slice(0, 400).map(rowHtml).join('') || `<tr><td colspan="${cols}" style="text-align:center;padding:24px;color:var(--text-muted)">No ${noun(2)} match.</td></tr>`) +
      (shown.length > 400 ? `<tr><td colspan="${cols}" style="padding:10px;font-size:12px;color:var(--text-muted)">Showing the first 400 of ${shown.length.toLocaleString()}. Narrow the filters or search.</td></tr>` : '');
  }
  window.txTableSearch = v => { S.tableQ = v; const tb = document.getElementById('txRows'); if (tb) tb.innerHTML = rowsHtml(filtered()); };
  window.txLook = v => {
    S.lookQ = v; const box = document.getElementById('txLookRes'); if (!box) return;
    if (String(v).trim().length < 2) { box.innerHTML = ''; return; }
    const hits = all().filter(e => matches(e, v)).slice(0, 8);
    box.innerHTML = hits.length ? hits.map(e => `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--gray-100);font-size:12.5px">
        <div><b>${esc(e.name)}</b><div style="color:var(--text-muted);font-size:11px">${esc(e.phone || 'no number')}${e.suburb ? ' · ' + esc(e.suburb) : ''}</div></div>
        ${e.hasMobile ? (S.picked.has(e.userId) ? '<span style="font-size:11px;color:#15803d">✓ added</span>' : `<button class="tx-chip" onclick="txAdd('${esc(e.userId)}')">+ Add</button>`) : '<span style="font-size:11px;color:var(--text-muted)">no mobile</span>'}</div>`).join('')
      : `<div style="font-size:12px;color:var(--text-muted);padding:6px 0">No ${noun(2)} found.</div>`;
  };
  const toE164 = p => { let d = String(p || '').replace(/[^\d+]/g, ''); if (d.startsWith('+')) return /^\+61[2-9]\d{8}$/.test(d) ? d : null; if (d.startsWith('61')) d = d.slice(2); d = d.replace(/^0/, ''); return /^4\d{8}$/.test(d) ? '+61' + d : null; };
  window.txAddNum = () => {
    const raw = document.getElementById('txNumIn').value, nm = document.getElementById('txNumName').value.trim();
    const e164 = toE164(raw);
    if (!e164) return say('Enter an Australian mobile, e.g. 0412 345 678', 'error');
    if (!e164.startsWith('+614')) return say('Only mobiles can receive texts', 'error');
    const id = 'tel:' + e164;
    const known = all().find(e => e.hasMobile && nd(e.phone) === nd(e164));
    if (known) { S.picked.add(known.userId); S.pinned.add(known.userId); say(`That number belongs to ${known.name} in RT. Added them.`, 'success'); renderNew(); return; }
    if (!S.numbers.some(n => n.userId === id)) S.numbers.push({ userId: id, name: nm || e164, phone: e164, hasMobile: true, type: 'number', kind: S.kind });
    S.picked.add(id); renderNew();
  };
  window.txRemoveNum = id => { S.numbers = S.numbers.filter(n => n.userId !== id); S.picked.delete(id); renderNew(); };
  window.txAdd = id => { S.picked.add(id); S.pinned.add(id); const q = S.lookQ; renderNew(); const el = document.getElementById('txLookIn'); if (el) { el.value = q; txLook(q); } };

  function newHtml() {
    if (!S.aud || (isC() && !S.audC)) return '<div class="spinner-wrap"><div class="spinner"></div></div>';
    const f = S.f, list = filtered();
    if (!S.picked) S.picked = new Set(); // nobody is pre-selected: the rep picks on purpose
    const picked = list.filter(e => S.picked.has(e.userId));
    const centres = S.aud.centres.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const x = seg((S.body || '').replace(/\{first_name\}/gi, 'Bartholomew'));
    const cost = picked.length * x.s * (S.usage?.costPerSegmentAud || 0.08);
    const replied = `<div class="tx-chips" style="margin-top:6px">${['any', 'yes', 'no'].map(v => `<button class="tx-chip ${f.replied === v ? 'on' : ''}" onclick="txSet('replied','${v}')">${{ any: 'Any reply history', yes: 'Has replied before', no: 'Never replied' }[v]}</button>`).join('')}</div>`;
    const notTexted = `<div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px">Not texted in the last <input type="number" min="0" max="90" value="${f.notTextedDays}" onchange="txSet('notTextedDays',Number(this.value)||0)" style="width:64px"> days</div>`;
    const filters = isC() ? `
        <div class="tx-f"><label class="h">State</label>${chips('cstate', opts('state'), f.cstate)}</div>
        <div class="tx-f"><label class="h">Bookings (RT)</label>${chips('booking', ['Booked in last 30 days', 'Booked in last 4 months', 'Dormant (4+ months)', 'Never booked'], f.booking)}</div>
        <div class="tx-f"><label class="h">Smart filters</label>
          <label style="display:block;font-size:13px"><input type="checkbox" ${f.mobileOnly ? 'checked' : ''} onchange="txSet('mobileOnly',this.checked)"> Only centres with a mobile number</label>${notTexted}${replied}</div>` : `
        <div class="tx-f"><label class="h">Status (RT)</label>${chips('status', opts('status'), f.status)}</div>
        <div class="tx-f"><label class="h">State</label>${chips('state', opts('state'), f.state)}</div>
        <div class="tx-f"><label class="h">Compliance (RT)</label><div class="tx-chips">${['any', 'yes', 'no'].map(v => `<button class="tx-chip ${f.compliance === v ? 'on' : ''}" onclick="txSet('compliance','${v}')">${{ any: 'Any', yes: 'Compliant', no: 'Not compliant' }[v]}</button>`).join('')}</div></div>
        <div class="tx-f"><label class="h">Onboarding</label>${chips('onboarding', obSort(opts('onboarding')), f.onboarding, v => OB_LABEL[v] || v)}</div>
        <div class="tx-f"><label class="h">Engagement</label>${chips('segment', Object.keys(SEG), f.segment, v => SEG[v])}</div>
        <div class="tx-f"><label class="h">Qualification</label>${chips('qual', opts('qualification'), f.qual)}</div>
        <div class="tx-f"><label class="h">Gender</label>${chips('gender', opts('gender'), f.gender)}</div>
        <div class="tx-f"><label class="h">Smart filters</label>
          <label style="display:block;font-size:13px"><input type="checkbox" ${f.avail ? 'checked' : ''} onchange="txSet('avail',this.checked)"> Has availability listed in RT</label>
          <label style="display:block;font-size:13px"><input type="checkbox" ${f.worked28 ? 'checked' : ''} onchange="txSet('worked28',this.checked)"> Worked a shift in the last 28 days</label>${notTexted}${replied}</div>`;
    const head = isC() ? '<th></th><th>Centre</th><th>Suburb</th><th>Bookings</th><th>Last booking</th><th>Last text</th>'
      : '<th></th><th>Educator</th><th>Suburb</th><th>Status</th><th>Compliance</th><th>Engagement</th><th>Availability</th><th>Last text</th>';
    return `<div class="tx-grid">
      <div class="tx-card tx-filters">
        <div class="tx-f"><label class="h">Sending to</label><div class="tx-switch" style="display:flex"><button style="flex:1" class="${isC() ? '' : 'on'}" onclick="txKind('educators')">👩‍🏫 Educators</button><button style="flex:1" class="${isC() ? 'on' : ''}" onclick="txKind('centres')">🏫 Centres</button></div></div>
        <div class="tx-f"><label class="h">Find a${isC() ? ' centre' : 'n educator'} by name or phone</label>
          <input type="text" id="txLookIn" value="${esc(S.lookQ)}" oninput="txLook(this.value)" placeholder="e.g. Sarah, 0412 345 678, +61412…" autocomplete="off">
          <div id="txLookRes"></div></div>
        <div class="tx-f"><label class="h">Or send to any number</label>
          <div style="display:flex;gap:6px"><input type="text" id="txNumIn" placeholder="0412 345 678" style="flex:1.2"><input type="text" id="txNumName" placeholder="Name (optional)" style="flex:1"></div>
          <button class="tx-chip" style="margin-top:6px" onclick="txAddNum()">+ Add number</button></div>
        <div class="tx-f"><label class="h">Near a centre</label>
          <select onchange="txSet('centre',this.value)"><option value="">Any location</option>${centres.map(c => `<option value="${esc(c.centreKey)}" ${f.centre === c.centreKey ? 'selected' : ''}>${esc(c.name)}${c.suburb ? ' (' + esc(c.suburb) + ')' : ''}</option>`).join('')}</select>
          ${f.centre ? `<div style="display:flex;align-items:center;gap:6px;margin-top:6px"><span style="font-size:12px">Within</span><input type="number" min="1" max="200" value="${f.radius}" onchange="txSet('radius',Number(this.value)||15)" style="width:80px"><span style="font-size:12px">km</span></div>` : ''}</div>
        ${filters}
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="tx-card" style="padding:14px">
          <div style="font-weight:700;color:var(--navy);margin-bottom:6px">Message</div>
          <div class="tx-compose" style="border:0;padding:0"><textarea id="txBody" placeholder="${isC() ? "Hi {first_name}, it's RawTalent. Do you need casual educators this week? Reply and we'll sort it." : "Hi {first_name}, it's RawTalent. We have shifts near you this week. Reply YES if you're keen."}" oninput="txBodyChange(this.value)">${esc(S.body)}</textarea>
          <div class="tx-count ${x.s > 1 || x.enc !== 'GSM-7' ? 'bad' : ''}" id="txBodyCount"><span>${x.n}/${x.max} characters · ${x.s} segment${x.s > 1 ? 's' : ''} per text${x.enc !== 'GSM-7' ? ' · emoji/special characters cut the limit to 70' : ''}</span><span>Use {first_name} to personalise${isC() ? ' (centre contact)' : ''}</span></div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
            <div style="font-size:13px"><b id="txPickCount">${picked.length}</b> of ${list.length.toLocaleString()} ${noun(2)} selected · <b id="txCost">≈ $${cost.toFixed(2)}</b> <span style="color:var(--text-muted)">(${picked.length * x.s} segments)</span></div>
            <div style="display:flex;gap:6px"><button class="btn-secondary" onclick="txPickAll(false)">Clear</button><button class="btn-secondary" onclick="txPickAll(true)">Select all</button><button class="btn-add" onclick="txSendMass()">Review & send</button></div></div>
        </div>
        <div class="tx-card" style="max-height:600px;overflow:auto">
          <div style="padding:10px;border-bottom:1px solid var(--gray-100)"><input type="text" value="${esc(S.tableQ)}" oninput="txTableSearch(this.value)" placeholder="🔍 Search this list by name or number (0412 345 678, 412345678, +61 412…)" style="width:100%;border:1px solid var(--gray-200);border-radius:8px;padding:7px 10px;font-family:inherit;font-size:13px"></div>
          <table class="tx-table"><thead><tr>${head}</tr></thead><tbody id="txRows">${rowsHtml(list)}</tbody></table>
          <div style="padding:8px 10px;font-size:11.5px;color:var(--text-muted)">${isC() ? 'Centres come from RT. Texts go to the centre/location mobile; landline-only centres can\'t be texted.' : `RT copy as of ${S.aud.generatedAt ? when(S.aud.generatedAt) : 'now'}. <span style="color:#2563eb">●</span> = re-checked live against RT just now (rows on screen are checked automatically).`}</div>
        </div>
      </div></div>`;
  }
  window.txBodyChange = v => { S.body = v; const sc = document.getElementById('txBodyCount'); const pc = document.getElementById('txCost');
    const x = seg(v.replace(/\{first_name\}/gi, 'Bartholomew')); const n = S.picked ? S.picked.size : 0;
    sc.className = 'tx-count' + (x.s > 1 || x.enc !== 'GSM-7' ? ' bad' : '');
    sc.firstElementChild.textContent = `${x.n}/${x.max} characters · ${x.s} segment${x.s > 1 ? 's' : ''} per text${x.enc !== 'GSM-7' ? ' · emoji/special characters cut the limit to 70' : ''}`;
    pc.textContent = `≈ $${(n * x.s * (S.usage?.costPerSegmentAud || 0.08)).toFixed(2)}`; pc.nextElementSibling.textContent = `(${n * x.s} segments)`; };
  window.txPick = (id, on) => { on ? S.picked.add(id) : S.picked.delete(id); const keep = S.body; renderNew(); S.body = keep; };
  window.txPickAll = on => { S.picked = new Set(on ? filtered().filter(e => e.hasMobile).slice(0, S.usage?.maxRecipients || 200).map(e => e.userId) : []); renderNew(); };
  window.txSendMass = async () => {
    const ids = [...S.picked], body = (S.body || '').trim();
    if (!ids.length) return say(`Select at least one ${noun(1)}`, 'error');
    if (!body) return say('Write the message first', 'error');
    const x = seg(body.replace(/\{first_name\}/gi, 'Bartholomew')), segs = ids.length * x.s, cost = segs * (S.usage?.costPerSegmentAud || 0.08);
    const msg = `Send this text to ${ids.length} ${noun(ids.length)}?\n\n"${body}"\n\n${x.s} segment${x.s > 1 ? 's' : ''} each · ${segs} segments · about $${cost.toFixed(2)}\nAnyone texted in the last ${S.usage?.cooldownHours || 24}h will be skipped.`;
    if (ids.length >= 20) { const t = prompt(msg + `\n\nType ${ids.length} to confirm.`); if (String(t || '').trim() !== String(ids.length)) return; }
    else if (!confirm(msg)) return;
    try {
      const f = S.f, c = f.centre && S.aud.centres.find(z => z.centreKey === f.centre);
      const note = [isC() ? 'Centres' : 'Educators', c ? `${f.radius}km of ${c.name}` : '', ...(isC() ? [[...f.cstate].join('/'), [...f.booking].join('/')] : [[...f.status].join('/'), [...f.state].join('/')])].filter(Boolean).join(' · ');
      const numberNames = Object.fromEntries(S.numbers.map(n => [n.userId, n.name === n.phone ? '' : n.name]));
      const r = await post('/api/educator-texts/send', { userIds: ids, body, audienceNote: note, numberNames });
      say(`${r.queued} text${r.queued === 1 ? '' : 's'} queued${r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map(s => s.why))].join('; ')})` : ''}${r.waitsForMorning ? '. They will go out after 8am.' : ''}`, 'success');
      S.body = ''; S.picked = null; S.pinned = new Set(); S.numbers = []; await loadUsage(); if (isC()) S.audC = await api('/api/educator-texts/audience?type=centres'); else S.aud = await api('/api/educator-texts/audience'); render();
    } catch (e) { say(e.message, 'error'); }
  };

  function renderNew() { const box = document.getElementById('txBox'); if (box) box.innerHTML = newHtml(); liveCheck(); }

  // Re-checks the educators on screen live against RT in the background
  // (max 60, each at most once per 5 minutes), then updates them in place.
  const checked = new Map(); let liveTimer = null;
  function liveCheck() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
      const now = Date.now();
      if (isC()) return;
      const ids = filtered().slice(0, 400).map(e => e.userId).filter(id => !(checked.get(id) > now - 300000)).slice(0, 60);
      if (!ids.length) return;
      ids.forEach(id => checked.set(id, now));
      try {
        const { educators } = await post('/api/educator-texts/live', { ids });
        for (const f of educators || []) {
          const e = S.aud.educators.find(x => x.userId === f.userId);
          if (!e) continue;
          e.liveAt = now;
          for (const k of ['status', 'onboarding', 'compliant', 'phone']) if (f[k] !== undefined && f[k] !== null) e[k] = f[k];
        }
        if (S.view === 'new') { const box = document.getElementById('txBox'); if (box) box.innerHTML = newHtml(); }
      } catch (err) { /* cached values stay */ }
    }, 500);
  }
  function render() {
    const root = document.getElementById('resultsList'); if (!root || (typeof currentMode !== 'undefined' && currentMode !== 'texts')) return;
    root.innerHTML = `${css}<div class="tx-wrap">${usageBar()}<div id="txBox">${S.view === 'inbox' ? inboxHtml() : newHtml()}</div></div>`;
    if (S.view === 'inbox' && S.open) txCount('txReply', 'txReplyCount');
  }
  window.txView = async v => { S.view = v; render(); if (v === 'new' && !S.aud) { try { S.aud = await api('/api/educator-texts/audience'); } catch (e) { say(e.message, 'error'); } render(); } };

  // Poll our own DB every 8s while the tab is open (cheap; no Customer.io calls).
  async function tick() {
    if (typeof currentMode !== 'undefined' && currentMode !== 'texts') { clearInterval(S.poll); S.poll = null; return; }
    if (document.hidden) return;
    try {
      const u = await api('/api/educator-texts/updates?since=' + S.maxId);
      if (u.maxId !== S.maxId || u.settled !== S.settled) {
        S.maxId = u.maxId; S.settled = u.settled;
        if (S.view === 'inbox') {
          const typing = document.getElementById('txReply')?.value || '';
          await loadConvos(); if (S.open) S.thread = await api(`/api/educator-texts/conversations/${encodeURIComponent(S.open)}`);
          render(); const ta = document.getElementById('txReply'); if (ta) { ta.value = typing; txCount('txReply', 'txReplyCount'); }
          const m = document.getElementById('txMsgs'); if (m) m.scrollTop = m.scrollHeight;
        }
      }
    } catch { /* try again next tick */ }
  }

  window.loadTextsView = async function () {
    const root = document.getElementById('resultsList');
    root.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
    try {
      await Promise.all([loadUsage(), loadConvos()]);
      const u = await api('/api/educator-texts/updates?since=0'); S.maxId = u.maxId; S.settled = u.settled;
      render();
      if (!S.poll) S.poll = setInterval(tick, 8000);
    } catch (e) { root.innerHTML = `<div class="empty-wrap"><div class="empty-title">${esc(e.message)}</div></div>`; }
  };
})();
