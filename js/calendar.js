// Optional Google Calendar free/busy, entirely in the browser.
//
// There is no server in this app, so this uses Google Identity Services' token
// client (the browser-side OAuth flow) and calls the Calendar REST API directly. That
// means you need your own OAuth client ID with this site's origin allowlisted —
// see README §"Connecting Google Calendar". Without one the app still works;
// it just assumes you are free during your session windows.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TOKEN_KEY = 'ksc:gtoken';

let gisPromise = null;
let tokenClient = null;

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google);
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => (window.google?.accounts?.oauth2
      ? resolve(window.google)
      : reject(new Error('Google Identity Services loaded but did not initialise')));
    s.onerror = () => reject(new Error('Could not reach accounts.google.com'));
    document.head.appendChild(s);
  });
  return gisPromise;
}

function readToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return t.expiresAt > Date.now() + 60_000 ? t : null;
  } catch { return null; }
}

function writeToken(token, expiresInSec) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
      token,
      expiresAt: Date.now() + (expiresInSec || 3600) * 1000,
    }));
  } catch { /* ignore */ }
}

export function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export function hasToken() {
  return !!readToken();
}

/**
 * Get an access token. `interactive: false` tries to refresh silently and
 * resolves to null rather than throwing a popup at someone who never asked.
 */
export async function authorise(clientId, { interactive = true } = {}) {
  const existing = readToken();
  if (existing) return existing.token;
  if (!clientId) throw new Error('No Google client ID configured');

  const google = await loadGis();

  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt: interactive ? '' : 'none',
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        writeToken(resp.access_token, Number(resp.expires_in));
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        if (!interactive) return resolve(null);
        reject(new Error(err?.message || 'Google sign-in was dismissed'));
      },
    });
    tokenClient.requestAccessToken();
  });
}

async function api(path, token, init = {}) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('Google session expired — sign in again');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Calendar API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function listCalendars(clientId) {
  const token = await authorise(clientId);
  const json = await api('/users/me/calendarList?minAccessRole=reader&maxResults=250', token);
  return (json.items || []).map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    primary: !!c.primary,
    selected: !!c.selected,
  }));
}

/**
 * Busy blocks across the given calendars.
 * @returns {Promise<Array<{start: Date, end: Date, calendarId: string}>>}
 */
export async function fetchBusy(clientId, calendarIds, timeMin, timeMax) {
  if (!clientId || !calendarIds?.length) return [];
  const token = await authorise(clientId, { interactive: false })
    || await authorise(clientId);
  if (!token) return [];

  const json = await api('/freeBusy', token, {
    method: 'POST',
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  });

  const out = [];
  for (const [calendarId, cal] of Object.entries(json.calendars || {})) {
    for (const b of cal.busy || []) {
      out.push({ start: new Date(b.start), end: new Date(b.end), calendarId });
    }
  }
  return mergeBusy(out);
}

/** Collapse overlapping busy blocks so the window maths stays simple. */
export function mergeBusy(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}
