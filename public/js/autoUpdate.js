// Keeps long-open HeartBeat tabs on the current version without anyone
// having to remember to refresh. Checks the server's build id every few
// minutes and whenever the tab comes back into view. When a new deploy is
// detected it reloads quietly — but only at a safe moment (tab hidden, or
// on return with nothing typed). If something is half-typed it shows a
// small bar instead, so no one loses work.
(function () {
  var CHECK_MS = 5 * 60 * 1000;
  var current = null, stale = false, bar = null;

  function hasUnsavedInput() {
    var els = document.querySelectorAll('input, textarea, [contenteditable="true"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.offsetParent && el !== document.activeElement) continue;
      if (el.isContentEditable) { if (el === document.activeElement || el.textContent.trim()) return true; continue; }
      var type = (el.type || '').toLowerCase();
      if (type === 'hidden' || type === 'search' || type === 'password') continue;
      if (type === 'checkbox' || type === 'radio') { if (el.checked !== el.defaultChecked) return true; continue; }
      if (el.value !== el.defaultValue) return true;
    }
    return false;
  }

  function showBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;' +
      'background:#1f2937;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:10px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;max-width:calc(100% - 32px)';
    bar.innerHTML = '<span>HeartBeat has been updated. Save what you’re working on, then refresh.</span>';
    var btn = document.createElement('button');
    btn.textContent = 'Refresh';
    btn.style.cssText = 'background:#fff;color:#1f2937;border:0;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer';
    btn.onclick = function () { location.reload(); };
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  function applyUpdate() {
    if (!hasUnsavedInput()) location.reload();
    else showBar();
  }

  function check() {
    fetch('/api/build-version', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.build) return;
        if (current === null) { current = d.build; return; }
        if (d.build !== current) { stale = true; if (document.hidden) applyUpdate(); else showBar(); }
      })
      .catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (stale) applyUpdate(); }
    else { if (stale) applyUpdate(); else check(); }
  });
  setInterval(check, CHECK_MS);
  check();
})();
