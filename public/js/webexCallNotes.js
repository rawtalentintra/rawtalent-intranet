// Webex Call Notes for a lead or centre (Joy, 2026-11-23). Shared by
// views/admin.html (Desktop) and views/wfp.html (Mobile). Lists Webex calls
// whose number matches the lead/centre, with a Play button for the
// recording and a "View Call Summary" popup (AI summary of the real
// transcript, plus the full transcript).
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtWhen = iso => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; }
  };
  const fmtDur = s => { s = Number(s) || 0; return s ? `${Math.floor(s / 60)}m ${s % 60}s` : ''; };
  const repName = n => String(n || '').replace(/\s+(\.|\d+)$/, '').trim() || 'Unknown';
  const OUTCOME = { positive: 'Positive', neutral: 'Neutral', concern: 'Concern', issue_raised: 'Issue raised' };
  const ctx = {};

  async function load(containerId, url, contextName) {
    const box = document.getElementById(containerId);
    if (!box) return;
    ctx[containerId] = contextName || '';
    box.innerHTML = '<div style="font-size:12.5px;color:#6b7280;padding:6px 0">Loading Webex calls…</div>';
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      const calls = await res.json();
      if (!document.body.contains(box)) return;
      if (!calls.length) { box.innerHTML = '<div style="font-size:12.5px;color:#6b7280;padding:6px 0">No Webex calls with this number yet.</div>'; return; }
      box.innerHTML = calls.map(c => `
        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:9px 11px;margin-bottom:7px;background:#fff">
          <div style="font-size:13px;color:#111827"><strong>${c.call_type === 'inbound' ? '📥 Inbound' : '📞 Outbound'}</strong> · ${esc(repName(c.rep_name))}${c.duration_seconds ? ' · ' + fmtDur(c.duration_seconds) : ''}</div>
          <div style="font-size:11.5px;color:#6b7280;margin-top:2px">${esc(fmtWhen(c.start_time_iso))} · ${esc(c.matchedNumber || '')}${c.call_summary_outcome ? ' · ' + esc(OUTCOME[c.call_summary_outcome] || c.call_summary_outcome) : ''}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px">
            ${c.has_audio ? `<button type="button" onclick="WebexCallNotes.play(this,'${esc(c.id)}')" style="${BTN}">▶ Play</button>` : `<span style="font-size:11.5px;color:#9ca3af;align-self:center">Recording not synced yet</span>`}
            <button type="button" onclick="WebexCallNotes.summary('${esc(c.id)}','${esc(containerId)}')" style="${BTN}">View Call Summary</button>
          </div>
          <div class="wcn-audio"></div>
        </div>`).join('');
    } catch {
      box.innerHTML = '<div style="font-size:12.5px;color:#6b7280;padding:6px 0">Couldn\'t load Webex calls.</div>';
    }
  }
  const BTN = 'padding:5px 11px;font-size:12px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;cursor:pointer;color:#111827';

  function play(btn, id) {
    const slot = btn.closest('div').parentElement.querySelector('.wcn-audio');
    if (slot.innerHTML) { slot.innerHTML = ''; btn.textContent = '▶ Play'; return; }
    slot.innerHTML = `<audio controls autoplay preload="auto" style="width:100%;margin-top:7px" src="/api/calls/local/${encodeURIComponent(id)}/audio"></audio>`;
    btn.textContent = '■ Hide player';
  }

  function modal(html) {
    let ov = document.getElementById('wcnModal');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'wcnModal';
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(17,24,39,.55);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;contain:paint;transform-style:flat';
      ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    }
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;max-height:85vh;overflow:auto;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.25);color:#111827">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><strong style="font-size:16px">Call Summary</strong>
      <button type="button" onclick="document.getElementById('wcnModal').remove()" style="border:none;background:none;font-size:22px;cursor:pointer;line-height:1">×</button></div>${html}</div>`;
  }

  async function summary(id, containerId) {
    modal('<div style="font-size:13px;color:#6b7280">Reading the transcript and writing the summary…</div>');
    try {
      const res = await fetch(`/api/calls/local/${encodeURIComponent(id)}/summary`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextName: ctx[containerId] || '' })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed');
      if (!document.getElementById('wcnModal')) return;
      if (!d.transcript) { modal('<div style="font-size:13px">No transcript for this call yet, so there\'s no summary. Webex/Dubber usually has it within the hour. You can still play the recording.</div>'); return; }
      modal(`${d.outcome ? `<div style="font-size:11.5px;font-weight:700;text-transform:uppercase;color:#6b7280;margin-bottom:4px">Outcome: ${esc(OUTCOME[d.outcome] || d.outcome)}</div>` : ''}
        <div style="font-size:14px;line-height:1.55;white-space:pre-wrap">${esc(d.summary || 'Summary could not be generated. See the transcript below.')}</div>
        <details style="margin-top:12px"><summary style="cursor:pointer;font-size:12.5px;color:#374151">Full transcript</summary>
        <div style="white-space:pre-wrap;font-size:12.5px;line-height:1.5;margin-top:6px;color:#374151">${esc(d.transcript)}</div></details>
        <div style="font-size:11px;color:#9ca3af;margin-top:10px">AI summary of the Webex transcript. Check the recording if anything matters.</div>`);
    } catch (e) {
      modal(`<div style="font-size:13px;color:#b91c1c">Couldn't load the summary: ${esc(e.message)}</div>`);
    }
  }

  window.WebexCallNotes = { load, play, summary };
})();
