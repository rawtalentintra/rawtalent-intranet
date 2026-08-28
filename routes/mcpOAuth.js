// OAuth 2.1 endpoints backing the MCP Custom Connector flow — mounted at
// the app root (not under /mcp) because OAuth discovery is origin-scoped
// (/.well-known/...) and /authorize, /token, /register are conventionally
// root-level too. See db/schema.sql's mcp_oauth_clients comment for why
// this exists: Claude's "Add Custom Connector" doesn't take a
// manually-pasted bearer token, it drives a real authorization-code+PKCE
// dance against the server's origin.
//
// This deliberately reuses HeartBeat's own session-cookie login for the
// human part of the flow (GET /authorize renders a consent screen behind
// the same Passport session everything else uses) rather than inventing
// a separate identity system — "authorize Claude" is just Joy, already
// logged into HeartBeat, clicking one more button. The payload it hands
// back is a normal mcp_tokens personal access token (services/
// mcpTokenService.js), so an OAuth-issued token shows up in, and can be
// revoked from, the same "Manage API Access" list as a manually-generated
// one — no parallel token system.
const express = require('express');
const router = express.Router();
const mcpOAuth = require('../services/mcpOAuthService');
const mcpTokens = require('../services/mcpTokenService');

// Deliberately NOT process.env.APP_URL (unlike config/passport.js's Google
// callback URL) — that var turned out to be unset/wrong in Railway's
// production environment, which silently advertised
// registration_endpoint etc. as http://localhost:3000 and broke Claude's
// "Couldn't register" flow (2026-08-28, reported live). Deriving the
// origin from the actual incoming request instead makes this correct
// regardless of that env var's state — trust proxy is already set in
// server.js, so req.protocol correctly reads 'https' behind Railway.
function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMessagePage(title, message, { showHomeLink = true } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)} — RawTalent HeartBeat</title>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/style.css"></head>
<body><div class="error-page">
<div class="error-title">${escHtml(title)}</div>
<p class="error-sub">${escHtml(message)}</p>
${showHomeLink ? '<br><a href="/" style="color:var(--orange);font-weight:600">← Return to HeartBeat</a>' : ''}
</div></body></html>`;
}

function renderConsentPage({ clientName, userEmail, params }) {
  // Params ride along as a JSON blob for the JS-driven submit below, not
  // hidden <input> fields — see the <script> at the bottom for why plain
  // <form method="POST"> wasn't reliable here. < escaping stops the
  // JSON from being able to close the <script> tag early.
  const paramsJson = JSON.stringify(params).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect to Claude — RawTalent HeartBeat</title>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/style.css"></head>
<body>
<div class="login-page">
  <div class="login-bg"></div>
  <div class="login-card">
    <div class="login-logo">
      <img src="/images/logo-dark-bg.png" alt="RawTalent" height="36" style="display:block;margin:0 auto 8px">
      <div class="login-logo-sub">HeartBeat</div>
    </div>
    <div style="text-align:center;color:white;font-size:15px;font-weight:700;margin-bottom:8px">Connect ${escHtml(clientName || 'this app')} to HeartBeat?</div>
    <div style="text-align:center;color:rgba(255,255,255,.6);font-size:12.5px;line-height:1.5;margin-bottom:22px">
      Signed in as <strong style="color:rgba(255,255,255,.85)">${escHtml(userEmail)}</strong>.<br>
      It'll be able to search the knowledge base, ask HeartBeat AI, and read your own tasks/leave requests on your behalf.
    </div>
    <div id="consentError" style="display:none;background:rgba(220,38,38,.15);border:1px solid rgba(220,38,38,.4);color:#fecaca;font-size:12px;line-height:1.5;padding:10px 12px;border-radius:8px;margin-bottom:14px"></div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button type="button" id="allowBtn" class="btn-primary">Allow</button>
      <button type="button" id="denyBtn" class="btn-google" style="justify-content:center">Cancel</button>
    </div>
    <noscript><div style="text-align:center;color:#fecaca;font-size:12px;margin-top:14px">This page needs JavaScript enabled to connect. Try opening this link in a regular browser tab.</div></noscript>
  </div>
</div>
<script>
  const CONSENT_PARAMS = ${paramsJson};
  // A plain <form method="POST"> here used to leave "Allow" doing
  // nothing at all, with zero visible error — reported live 2026-08-28.
  // Most likely cause: Claude shows this page inside a restricted embed
  // (e.g. a sandboxed iframe) that blocks form-submission navigation.
  // fetch() isn't restricted by that same sandbox flag, so this posts
  // via fetch and then explicitly navigates window.top (falling back to
  // window.location if that's blocked too) — and either way, any failure
  // now shows a real message instead of silently doing nothing.
  async function decide(decision) {
    const allowBtn = document.getElementById('allowBtn');
    const denyBtn = document.getElementById('denyBtn');
    const errEl = document.getElementById('consentError');
    errEl.style.display = 'none';
    allowBtn.disabled = denyBtn.disabled = true;
    const clickedBtn = decision === 'allow' ? allowBtn : denyBtn;
    const originalText = clickedBtn.textContent;
    clickedBtn.textContent = decision === 'allow' ? 'Connecting…' : 'Cancelling…';
    try {
      const res = await fetch('/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(Object.assign({ decision }, CONSENT_PARAMS))
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.redirectTo) {
        throw new Error((data && data.error_description) || ('Server returned ' + res.status));
      }
      try { window.top.location.href = data.redirectTo; }
      catch (navErr) { window.location.href = data.redirectTo; }
    } catch (e) {
      errEl.textContent = "Couldn't complete this: " + e.message + '. Try again, or use the "Report issues" link in Claude\\'s Add Custom Connector dialog if it keeps happening.';
      errEl.style.display = 'block';
      clickedBtn.textContent = originalText;
      allowBtn.disabled = denyBtn.disabled = false;
    }
  }
  document.getElementById('allowBtn').addEventListener('click', () => decide('allow'));
  document.getElementById('denyBtn').addEventListener('click', () => decide('deny'));
</script>
</body></html>`;
}

function errorRedirectUrl(redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

// The consent page's JS (see renderConsentPage) posts with
// Accept: application/json and does the actual top-level navigation
// itself — a plain 302 here wouldn't reach the browser's address bar at
// all from a fetch() call, it'd just be fetch() transparently following
// it as a second background request. Anything else (a form POST, or a
// future caller with no JS) still gets a normal redirect.
function respondWithRedirect(req, res, url) {
  if (wantsJson(req)) { res.json({ redirectTo: url }); return; }
  res.redirect(url);
}
function wantsJson(req) {
  return req.is('application/json') || (req.headers.accept || '').includes('application/json');
}

// RFC 8414 — points Claude at /authorize, /token, /register and tells it
// PKCE S256 + no client_secret ("none") is how this server works.
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const origin = baseUrl(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp']
  });
});

// RFC 9728 — tells Claude which authorization server protects /mcp.
// Registered at both the generic path and a resource-scoped one since
// clients vary on which they probe first.
const protectedResourceMeta = (req) => { const origin = baseUrl(req); return { resource: `${origin}/mcp`, authorization_servers: [origin] }; };
router.get('/.well-known/oauth-protected-resource', (req, res) => res.json(protectedResourceMeta(req)));
router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => res.json(protectedResourceMeta(req)));

// RFC 7591 Dynamic Client Registration — open/unauthenticated, same as
// every real-world implementation of this endpoint (Claude has no
// credential to present yet at this point in the flow). Safe to leave
// open: registering a client record grants nothing by itself — /authorize
// still requires a real HeartBeat super_admin session before it'll ever
// hand out a code.
router.post('/register', async (req, res) => {
  try {
    const { client_name, redirect_uris } = req.body || {};
    const client = await mcpOAuth.registerClient({ clientName: client_name, redirectUris: redirect_uris });
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code']
    });
  } catch (err) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: err.message });
  }
});

async function validateAuthorizeRequest(req, res) {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method } = req.query;
  if (!client_id || !redirect_uri) {
    res.status(400).send(renderMessagePage('Invalid Request', 'This connection request is missing required information — try reconnecting from Claude.'));
    return null;
  }
  const client = await mcpOAuth.getClient(client_id);
  if (!client) {
    res.status(400).send(renderMessagePage('Unknown Connector', "This connector isn't registered with HeartBeat — try removing and re-adding it in Claude."));
    return null;
  }
  // Exact match only — this is the check that stops a code minted here
  // from ever being deliverable anywhere but the address Claude itself
  // registered.
  if (!client.redirect_uris.includes(redirect_uri)) {
    res.status(400).send(renderMessagePage('Redirect Mismatch', "This request's redirect address doesn't match what was registered — try reconnecting from Claude."));
    return null;
  }
  if (response_type !== 'code') {
    res.redirect(errorRedirectUrl(redirect_uri, req.query.state, 'unsupported_response_type', 'Only "code" is supported.'));
    return null;
  }
  if (!code_challenge || (code_challenge_method && code_challenge_method !== 'S256')) {
    res.redirect(errorRedirectUrl(redirect_uri, req.query.state, 'invalid_request', 'PKCE (S256) is required.'));
    return null;
  }
  return client;
}

router.get('/authorize', async (req, res) => {
  const client = await validateAuthorizeRequest(req, res);
  if (!client) return; // response already sent

  if (!req.isAuthenticated()) {
    res.redirect(`/login.html?returnTo=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  // Same restriction as routes/mcp.js's own data-access gate (Joy
  // 2026-08-28) — enforced here too so someone else logged into HeartBeat
  // can't even reach the consent screen, not just fail later at /mcp.
  if (req.user.role !== 'super_admin') {
    res.status(403).send(renderMessagePage('Access Restricted', 'MCP access is limited to the HeartBeat super admin account. Sign in as that account to connect this.'));
    return;
  }

  res.send(renderConsentPage({
    clientName: client.client_name,
    userEmail: req.user.email,
    params: {
      client_id: req.query.client_id,
      redirect_uri: req.query.redirect_uri,
      state: req.query.state || '',
      code_challenge: req.query.code_challenge,
      code_challenge_method: req.query.code_challenge_method || 'S256',
      scope: req.query.scope || ''
    }
  }));
});

router.post('/authorize', async (req, res) => {
  const { decision, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.body || {};
  if (!req.isAuthenticated() || req.user.role !== 'super_admin') {
    const message = 'MCP access is limited to the HeartBeat super admin account.';
    if (wantsJson(req)) { res.status(403).json({ error_description: message }); return; }
    res.status(403).send(renderMessagePage('Access Restricted', message));
    return;
  }
  const client = client_id ? await mcpOAuth.getClient(client_id) : null;
  if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    const message = 'This connection request is no longer valid — try reconnecting from Claude.';
    if (wantsJson(req)) { res.status(400).json({ error_description: message }); return; }
    res.status(400).send(renderMessagePage('Invalid Request', message));
    return;
  }
  if (decision !== 'allow') {
    respondWithRedirect(req, res, errorRedirectUrl(redirect_uri, state, 'access_denied', 'The user denied the request.'));
    return;
  }
  const code = mcpOAuth.issueCode({
    clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || 'S256', email: req.user.email, scope
  });
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  respondWithRedirect(req, res, url.toString());
});

router.post('/token', async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body || {};
  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  if (!code || !code_verifier || !client_id || !redirect_uri) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing code, code_verifier, client_id, or redirect_uri.' });
    return;
  }
  const entry = mcpOAuth.consumeCode(code); // single-use — a retry with the same code always fails from here on
  if (!entry) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Code is invalid, expired, or already used.' });
    return;
  }
  if (entry.clientId !== client_id || entry.redirectUri !== redirect_uri) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'client_id or redirect_uri does not match the original request.' });
    return;
  }
  if (!mcpOAuth.verifyPkce(code_verifier, entry.codeChallenge)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
    return;
  }
  try {
    // A normal mcp_tokens PAT — same verifyToken() path every other MCP
    // call already goes through, so it shows up in (and can be revoked
    // from) the ordinary "Manage API Access" list, no parallel system.
    const accessToken = await mcpTokens.generateToken(entry.email, 'Claude (OAuth connector)');
    res.json({ access_token: accessToken, token_type: 'bearer', scope: entry.scope || 'mcp' });
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

module.exports = router;
