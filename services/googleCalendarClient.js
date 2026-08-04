const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getServiceAccountCredentials() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return null;
  try {
    return JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString());
  } catch {
    console.warn('Calendar: invalid service account key');
    return null;
  }
}

// 'delegation' (default): the same service account already used for Drive
// impersonates the partner's own rawtalent.com.au mailbox via domain-wide
// delegation — requires that delegation to be authorized once in the
// Workspace Admin console (Security → Access and data control → API
// controls → Domain-wide Delegation), using this service account's Client
// ID and the calendar scope above. No per-partner login needed.
// 'oauth': per-partner OAuth consent, for a partner without a Workspace
// account on the rawtalent.com.au domain. Not implemented yet — see the
// note in routes/calendarSync.js — because it needs a consent screen and
// a place to store each partner's own refresh token, which is a separate
// build once we know it's actually needed for one of the three partners.
function authMode() {
  return process.env.CALENDAR_AUTH_MODE === 'oauth' ? 'oauth' : 'delegation';
}

function getCalendarClientFor(ownerEmail) {
  if (authMode() === 'oauth') {
    throw new Error(
      `Calendar sync for ${ownerEmail} needs per-partner OAuth, which isn't built yet ` +
      `(CALENDAR_AUTH_MODE=oauth). Domain-wide delegation is the only supported path today.`
    );
  }
  const credentials = getServiceAccountCredentials();
  if (!credentials) return null;
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
    subject: ownerEmail
  });
  return google.calendar({ version: 'v3', auth });
}

function isConfigured() {
  return !!getServiceAccountCredentials();
}

module.exports = { getCalendarClientFor, isConfigured, authMode };
