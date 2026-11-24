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
         centre: '', radius: 15, avail: false, worked28: false, notTextedDays: 7, replied: 'any', search: '' },
    picked: null, body: '' };

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
        <a href="https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${encodeURIComponent(S.open)}" target="_blank" rel="noopener" style="font-size:12px;color:#2563eb">Open in RT Portal ↗</a></div>
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
  function filtered() {
    const f = S.f, a = S.aud; if (!a) return [];
    const c = f.centre ? a.centres.find(x => x.centreKey === f.centre) : null;
    const notSince = f.notTextedDays ? Date.now() - f.notTextedDays * 864e5 : null;
    const q = f.search.trim().toLowerCase();
    return a.educators.filter(e =>
      (!f.status.size || f.status.has(e.status)) && (!f.state.size || f.state.has(e.state || 'Unknown')) &&
      (!f.onboarding.size || f.onboarding.has(e.onboarding || 'Not started')) &&
      (f.compliance === 'any' || (f.compliance === 'yes') === !!e.compliant) &&
      (!f.gender.size || f.gender.has(e.gender || 'Unknown')) && (!f.qual.size || f.qual.has(e.qualification || 'Unknown')) &&
      (!f.segment.size || f.segment.has(e.segment)) && (!f.avail || e.availDays > 0) && (!f.worked28 || e.shifts28d > 0) &&
      (!notSince || !e.lastTextAt || new Date(e.lastTextAt).getTime() < notSince) &&
      (f.replied === 'any' || (f.replied === 'yes') === !!e.lastReplyAt) &&
      (!q || (e.name || '').toLowerCase().includes(q) || (e.suburb || '').toLowerCase().includes(q))
    ).map(e => c ? { ...e, dist: km(c.lat, c.lng, e.lat, e.lng) } : e)
     .filter(e => !c || e.dist <= f.radius)
     .sort((x, y) => c ? x.dist - y.dist : (x.name || '').localeCompare(y.name || ''));
  }
  const opts = key => [...new Set(S.aud.educators.map(e => (key === 'onboarding' ? e.onboarding || 'Not started' : e[key] || 'Unknown')))].sort();
  function chips(name, values, set, label = v => v) {
    return `<div class="tx-chips">${values.map(v => `<button class="tx-chip ${set.has(v) ? 'on' : ''}" onclick="txChip('${name}','${esc(v).replace(/'/g, '&#39;')}')">${esc(label(v))}</button>`).join('')}</div>`;
  }
  window.txChip = (name, v) => { const s = S.f[name]; s.has(v) ? s.delete(v) : s.add(v); S.picked = null; renderNew(); };
  window.txSet = (k, v) => { S.f[k] = v; S.picked = null; renderNew(); };

  function newHtml() {
    if (!S.aud) return '<div class="spinner-wrap"><div class="spinner"></div></div>';
    const f = S.f, list = filtered();
    if (!S.picked) S.picked = new Set(); // nobody is pre-selected: the rep picks on purpose
    const picked = list.filter(e => S.picked.has(e.userId));
    const centres = S.aud.centres.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const x = seg((S.body || '').replace(/\{first_name\}/gi, 'Bartholomew'));
    const cost = picked.length * x.s * (S.usage?.costPerSegmentAud || 0.08);
    const rows = list.slice(0, 400).map(e => `<tr>
      <td><input type="checkbox" ${S.picked.has(e.userId) ? 'checked' : ''} ${e.hasMobile ? '' : 'disabled title="No valid mobile"'} onchange="txPick('${e.userId}',this.checked)"></td>
      <td><b>${esc(e.name)}</b><div style="color:var(--text-muted);font-size:11px">${esc(e.phone || 'no mobile')}</div></td>
      <td>${esc(e.suburb || '')}${e.state ? ', ' + e.state : ''}${e.dist != null ? `<div style="color:var(--text-muted);font-size:11px">${e.dist.toFixed(1)} km</div>` : ''}</td>
      <td>${esc(e.status || '')}</td><td class="${e.compliant ? 'tx-ok' : 'tx-no'}">${e.compliant ? 'Compliant' : 'Not compliant'}${e.liveAt ? ' <span title="Checked live against RT just now" style="color:#2563eb">●</span>' : ''}</td>
      <td>${esc(SEG[e.segment] || '')}</td><td>${e.availDays ? e.availDays + ' days' : '-'}</td>
      <td>${e.lastTextAt ? ago(e.lastTextAt) + ' ago' : '-'}${e.lastReplyAt ? ' · replied' : ''}</td></tr>`).join('');
    return `<div class="tx-grid">
      <div class="tx-card tx-filters">
        <div class="tx-f"><label class="h">Near a centre</label>
          <select onchange="txSet('centre',this.value)"><option value="">Any location</option>${centres.map(c => `<option value="${esc(c.centreKey)}" ${f.centre === c.centreKey ? 'selected' : ''}>${esc(c.name)}${c.suburb ? ' (' + esc(c.suburb) + ')' : ''}</option>`).join('')}</select>
          ${f.centre ? `<div style="display:flex;align-items:center;gap:6px;margin-top:6px"><span style="font-size:12px">Within</span><input type="number" min="1" max="200" value="${f.radius}" onchange="txSet('radius',Number(this.value)||15)" style="width:80px"><span style="font-size:12px">km</span></div>` : ''}</div>
        <div class="tx-f"><label class="h">Status (RT)</label>${chips('status', opts('status'), f.status)}</div>
        <div class="tx-f"><label class="h">State</label>${chips('state', opts('state'), f.state)}</div>
        <div class="tx-f"><label class="h">Compliance (RT)</label><div class="tx-chips">${['any', 'yes', 'no'].map(v => `<button class="tx-chip ${f.compliance === v ? 'on' : ''}" onclick="txSet('compliance','${v}')">${{ any: 'Any', yes: 'Compliant', no: 'Not compliant' }[v]}</button>`).join('')}</div></div>
        <div class="tx-f"><label class="h">Onboarding</label>${chips('onboarding', opts('onboarding'), f.onboarding)}</div>
        <div class="tx-f"><label class="h">Engagement</label>${chips('segment', Object.keys(SEG), f.segment, v => SEG[v])}</div>
        <div class="tx-f"><label class="h">Qualification</label>${chips('qual', opts('qualification'), f.qual)}</div>
        <div class="tx-f"><label class="h">Gender</label>${chips('gender', opts('gender'), f.gender)}</div>
        <div class="tx-f"><label class="h">Smart filters</label>
          <label style="display:block;font-size:13px"><input type="checkbox" ${f.avail ? 'checked' : ''} onchange="txSet('avail',this.checked)"> Has availability listed in RT</label>
          <label style="display:block;font-size:13px"><input type="checkbox" ${f.worked28 ? 'checked' : ''} onchange="txSet('worked28',this.checked)"> Worked a shift in the last 28 days</label>
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px">Not texted in the last <input type="number" min="0" max="90" value="${f.notTextedDays}" onchange="txSet('notTextedDays',Number(this.value)||0)" style="width:64px"> days</div>
          <div class="tx-chips" style="margin-top:6px">${['any', 'yes', 'no'].map(v => `<button class="tx-chip ${f.replied === v ? 'on' : ''}" onclick="txSet('replied','${v}')">${{ any: 'Any reply history', yes: 'Has replied before', no: 'Never replied' }[v]}</button>`).join('')}</div></div>
        <div class="tx-f"><label class="h">Name or suburb</label><input type="text" value="${esc(f.search)}" onchange="txSet('search',this.value)" placeholder="Search…"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="tx-card" style="padding:14px">
          <div style="font-weight:700;color:var(--navy);margin-bottom:6px">Message</div>
          <div class="tx-compose" style="border:0;padding:0"><textarea id="txBody" placeholder="Hi {first_name}, it's RawTalent. We have shifts near you this week. Reply YES if you're keen." oninput="txBodyChange(this.value)">${esc(S.body)}</textarea>
          <div class="tx-count ${x.s > 1 || x.enc !== 'GSM-7' ? 'bad' : ''}" id="txBodyCount"><span>${x.n}/${x.max} characters · ${x.s} segment${x.s > 1 ? 's' : ''} per text${x.enc !== 'GSM-7' ? ' · emoji/special characters cut the limit to 70' : ''}</span><span>Use {first_name} to personalise</span></div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
            <div style="font-size:13px"><b id="txPickCount">${picked.length}</b> of ${list.length.toLocaleString()} selected · <b id="txCost">≈ $${cost.toFixed(2)}</b> <span style="color:var(--text-muted)">(${picked.length * x.s} segments)</span></div>
            <div style="display:flex;gap:6px"><button class="btn-secondary" onclick="txPickAll(false)">Clear</button><button class="btn-secondary" onclick="txPickAll(true)">Select all</button><button class="btn-add" onclick="txSendMass()">Review & send</button></div></div>
        </div>
        <div class="tx-card" style="max-height:560px;overflow:auto"><table class="tx-table"><thead><tr><th></th><th>Educator</th><th>Suburb</th><th>Status</th><th>Compliance</th><th>Engagement</th><th>Availability</th><th>Last text</th></tr></thead><tbody>${rows || '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No educators match these filters.</td></tr>'}</tbody></table>
          <div style="padding:8px 10px;font-size:11.5px;color:var(--text-muted)">RT copy as of ${S.aud.generatedAt ? when(S.aud.generatedAt) : 'now'}. <span style="color:#2563eb">●</span> = re-checked live against RT just now (rows on screen are checked automatically).</div>
          ${list.length > 400 ? `<div style="padding:10px;font-size:12px;color:var(--text-muted)">Showing the first 400 of ${list.length.toLocaleString()}. Narrow the filters.</div>` : ''}</div>
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
    if (!ids.length) return say('Select at least one educator', 'error');
    if (!body) return say('Write the message first', 'error');
    const x = seg(body.replace(/\{first_name\}/gi, 'Bartholomew')), segs = ids.length * x.s, cost = segs * (S.usage?.costPerSegmentAud || 0.08);
    const msg = `Send this text to ${ids.length} educator${ids.length > 1 ? 's' : ''}?\n\n"${body}"\n\n${x.s} segment${x.s > 1 ? 's' : ''} each · ${segs} segments · about $${cost.toFixed(2)}\nAnyone texted in the last ${S.usage?.cooldownHours || 24}h will be skipped.`;
    if (ids.length >= 20) { const t = prompt(msg + `\n\nType ${ids.length} to confirm.`); if (String(t || '').trim() !== String(ids.length)) return; }
    else if (!confirm(msg)) return;
    try {
      const f = S.f, c = f.centre && S.aud.centres.find(z => z.centreKey === f.centre);
      const note = [c ? `${f.radius}km of ${c.name}` : '', [...f.status].join('/'), [...f.state].join('/')].filter(Boolean).join(' · ');
      const r = await post('/api/educator-texts/send', { userIds: ids, body, audienceNote: note });
      say(`${r.queued} text${r.queued === 1 ? '' : 's'} queued${r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map(s => s.why))].join('; ')})` : ''}${r.waitsForMorning ? '. They will go out after 8am.' : ''}`, 'success');
      S.body = ''; S.picked = null; await loadUsage(); S.aud = await api('/api/educator-texts/audience'); render();
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
