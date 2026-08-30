// Controller: owns state, fetches, and tells ui.js what to draw.

import { SPOTS, getSpot } from './spots.js';
import { CRAFT, getCraft } from './craft.js';
import { loadSpot, FORECAST_DAYS } from './api.js';
import { scoreHour, verdictFor } from './scoring.js';
import { kitAdvice, safetyFlags } from './kit.js';
import { findBestWindows } from './windows.js';
import { loadSettings, saveSettings, resetSettings, DEFAULT_SETTINGS } from './store.js';
import * as cal from './calendar.js';
import * as ui from './ui.js';
import { fmtClock } from './util.js';
import { iconHtml } from './icons.js';
import { renderRivers, measureRivers } from './rivers.js';
import { renderSettings } from './settings-ui.js';
import { demoForecast, isDemo } from './demo.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: loadSettings(),
  forecasts: new Map(),   // spotId → forecast
  busy: [],
  calStatus: { state: 'off', message: '' },
  view: 'now',
  selected: null,         // hour the user tapped, or null for "now"
  loading: false,
  error: null,
};

// --- helpers ---------------------------------------------------------------

const activeSpot = () => getSpot(state.settings.spotId);
const activeCraft = () => getCraft(state.settings.craftId);
const forecast = () => state.forecasts.get(state.settings.spotId);

function nearestHour(fc, when = new Date()) {
  if (!fc?.hours?.length) return null;
  return fc.hours.reduce((a, b) => (Math.abs(b.time - when) < Math.abs(a.time - when) ? b : a));
}

function scoredHours(fc, spot, craft) {
  return fc.hours.map((hour) => ({ hour, res: scoreHour(hour, spot, craft) }));
}

function persist() { saveSettings(state.settings); }

// --- data ------------------------------------------------------------------

async function loadAll({ force = false } = {}) {
  state.loading = true;
  state.error = null;
  $('refreshBtn').setAttribute('aria-busy', 'true');
  render();

  const wanted = SPOTS.filter((s) => state.settings.enabledSpots.includes(s.id) || s.id === state.settings.spotId);

  const results = await Promise.all(wanted.map(async (spot) => {
    if (isDemo()) return { spot, forecast: demoForecast(spot), fromCache: false, error: null };
    const r = await loadSpot(spot, { force });
    return { spot, ...r };
  }));

  let anyLive = false;
  let lastError = null;
  for (const r of results) {
    if (r.forecast) state.forecasts.set(r.spot.id, r.forecast);
    if (r.error) lastError = r.error;
    if (!r.fromCache && r.forecast) anyLive = true;
  }

  if (!state.forecasts.size) state.error = lastError || new Error('No forecast available');
  else if (lastError && !anyLive) state.error = lastError;

  state.loading = false;
  $('refreshBtn').removeAttribute('aria-busy');

  await refreshCalendar({ interactive: false });
  render();
}

async function refreshCalendar({ interactive = false } = {}) {
  const g = state.settings.google;
  if (!g.enabled || !g.clientId || !g.calendarIds.length) {
    state.busy = [];
    state.calStatus = {
      state: 'off',
      message: g.enabled && !g.clientId
        ? 'Google Calendar is switched on but has no client ID yet — add one in Settings.'
        : 'Not connected. Sessions are ranked across all your free-time windows.',
    };
    return;
  }

  if (!interactive && !cal.hasToken()) {
    state.calStatus = { state: 'needs-auth', message: 'Tap to sign in to Google and filter by your diary.' };
    return;
  }

  try {
    const now = new Date();
    const to = new Date(+now + (FORECAST_DAYS + 1) * 86400e3);
    state.busy = await cal.fetchBusy(g.clientId, g.calendarIds, now, to);
    state.calStatus = {
      state: 'on',
      message: `${state.busy.length} busy block${state.busy.length === 1 ? '' : 's'} from ${g.calendarIds.length} calendar${g.calendarIds.length === 1 ? '' : 's'}.`,
    };
  } catch (err) {
    state.busy = [];
    state.calStatus = { state: 'error', message: err.message };
  }
}

// --- rendering -------------------------------------------------------------

function render() {
  if (state.view === 'rivers') { measureRivers(); return; }
  const spot = activeSpot();
  const craft = activeCraft();
  const fc = forecast();

  // Selectors, with a live score against each so you can compare at a glance.
  const now = new Date();
  const spotScores = new Map();
  for (const s of SPOTS) {
    const f = state.forecasts.get(s.id);
    const h = f && nearestHour(f, now);
    if (h) spotScores.set(s.id, scoreHour(h, s, craft).score);
  }
  const craftScores = new Map();
  if (fc) {
    const h = nearestHour(fc, now);
    for (const c of CRAFT) if (h) craftScores.set(c.id, scoreHour(h, spot, c).score);
  }

  ui.renderCraft($('craftRow'), CRAFT, craft.id, (id) => {
    state.settings.craftId = id; persist(); render();
  }, craftScores);

  const visibleSpots = SPOTS.filter((s) => state.settings.enabledSpots.includes(s.id) || s.id === spot.id);
  const pickSpot = (id) => {
    state.settings.spotId = id;
    state.selected = null;
    persist();
    if (!state.forecasts.has(id)) loadAll(); else render();
  };
  ui.renderSpots($('spotRow'), visibleSpots, spot.id, pickSpot, spotScores);
  ui.renderSpots($('spotRowForecast'), visibleSpots, spot.id, pickSpot, spotScores);

  $('brandSub').textContent = spot.name;

  renderBanners(fc);

  if (!fc) {
    $('heroCard').innerHTML = state.loading
      ? '<div class="skeleton" style="height:96px"></div>'
      : `<div class="empty">${iconHtml('offline')}<div>Couldn't load the forecast.</div>
         <div class="muted">${escapeHtml(state.error?.message || '')}</div></div>`;
    $('nextBest').replaceChildren();
    return;
  }

  const hours = scoredHours(fc, spot, craft);
  const hour = state.selected
    ? (hours.find((e) => +e.hour.time === +state.selected)?.hour ?? nearestHour(fc, now))
    : nearestHour(fc, now);
  const res = scoreHour(hour, spot, craft);
  const regime = fc.tideRegime?.forDate(hour.time);

  // Windows first — the hero needs the best one to answer "or should I wait?".
  const spots = SPOTS.filter((s) => state.settings.enabledSpots.includes(s.id) && state.forecasts.has(s.id));
  const windows = findBestWindows(state.forecasts, spots.length ? spots : [spot], craft, state.settings, {
    busy: state.busy, now, limit: 10,
  });

  const jumpTo = (w) => {
    state.settings.spotId = w.spot.id;
    state.selected = +w.peakAt;
    persist();
    setView('now');
  };

  // --- Now
  ui.renderHero($('heroCard'), {
    res, spot, craft, hour, units: state.settings.units,
    verdict: verdictFor(res, spot, craft, { future: hour.time > new Date(+now + 60 * 60000) }),
  });

  // Only offer a future window — "go now" is what the hero already says.
  const upcoming = windows.filter((w) => w.start > new Date(+now + 45 * 60000));
  const nextBest = upcoming.reduce((a, b) => (!a || b.mean > a.mean ? b : a), null);
  ui.renderNextBest($('nextBest'), nextBest, {
    now,
    current: state.selected ? null : res.score,
    onPick: jumpTo,
  });

  $('statsCard').hidden = false;
  ui.renderStats($('statsGrid'), { res, hour, units: state.settings.units, tideRegime: regime });
  ui.renderAgreement($('statsAgreement'), hour);
  $('statsNote').textContent = state.selected ? `at ${fmtClock(hour.time)}` : 'now';

  $('partsCard').hidden = false;
  ui.renderParts($('partsList'), $('partsExplain'), $('partsLimiting'), { res, spot, craft });

  $('flagsCard').hidden = false;
  ui.renderFlags($('flagsList'), safetyFlags({ scored: res, hour, spot, craft, regime }));

  $('kitCard').hidden = false;
  ui.renderKit($('kitSuit'), $('kitExtras'), $('kitChill'), $('kitNote'),
    kitAdvice(hour.seaTemp, hour.apparentTemp));

  $('tideCard').hidden = false;
  ui.renderTide($('tideChart'), $('tideEvents'), $('tideNote'),
    { forecast: fc, now: hour.time, units: state.settings.units });

  // --- Best windows
  ui.renderWindows($('windowsList'), windows, {
    now, units: state.settings.units, onPick: jumpTo,
  });

  $('windowsNote').textContent = spots.length > 1 ? `best of ${spots.length} spots` : spot.short;
  renderCalStatus();

  // --- Forecast
  ui.renderDays($('days'), $('forecastTable'), {
    forecast: fc, spot, craft, scoredHours: hours, now,
    units: state.settings.units,
    onPick: (h, r, cell) => {
      state.selected = +h.time;
      ui.showTooltip($('tooltip'), cell, { hour: h, res: r, units: state.settings.units });
      for (const c of $('days').querySelectorAll('.cell')) c.removeAttribute('aria-selected');
      cell.setAttribute('aria-selected', 'true');
      render();
    },
  });
  $('forecastNote').textContent = craft.name;
  ui.renderLegend($('legendRamp'), $('legendUnit'), state.settings.units);
}

function renderBanners(fc) {
  const banners = [];
  if (state.error && fc) {
    banners.push({ icon: 'offline', text: `Showing saved data — ${state.error.message}` });
  }
  if (fc?.missing?.length) {
    banners.push({
      icon: 'offline',
      text: `Part of the forecast didn't load — no ${fc.missing.join(' or ')}. Everything else is live.`,
    });
  }
  if (fc?.stale || (fc && Date.now() - fc.fetchedAt > 6 * 3600e3)) {
    const age = Math.round((Date.now() - fc.fetchedAt) / 3600e3);
    banners.push({ icon: 'info', text: `Forecast is ${age}h old. Pull to refresh when you have signal.` });
  }
  if (isDemo()) {
    banners.push({ icon: 'flask', text: 'Demo mode — made-up data, not a real forecast. Drop ?demo=1 for the live one.' });
  }
  if (state.selected) {
    const t = new Date(state.selected);
    banners.push({ icon: 'hand', text: `Showing ${fmtClock(t)}. Tap here to go back to now.`, clear: true });
  }
  ui.renderBanners($('banners'), banners);
  if (state.selected) {
    const last = $('banners').lastElementChild;
    if (last) {
      last.style.cursor = 'pointer';
      last.addEventListener('click', () => { state.selected = null; render(); });
    }
  }
}

function renderCalStatus() {
  const root = $('calStatus');
  root.replaceChildren();

  const p = document.createElement('p');
  p.className = 'muted';
  p.style.margin = '0 0 10px';
  p.textContent = state.calStatus.message;
  root.append(p);

  if (state.calStatus.state === 'needs-auth' || state.calStatus.state === 'error') {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = 'Connect Google Calendar';
    b.addEventListener('click', async () => {
      b.disabled = true;
      await refreshCalendar({ interactive: true });
      render();
    });
    root.append(b);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- views -----------------------------------------------------------------

const VIEWS = ['now', 'windows', 'forecast', 'rivers'];

function setView(view) {
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const b of document.querySelectorAll('.nav__btn')) {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }

  // The craft control and the spot row are surf-only; on the Rivers tab they
  // are noise, and the embed wants every pixel it can get.
  const rivers = view === 'rivers';
  $('craftRow').hidden = rivers;
  document.body.classList.toggle('rivers-open', rivers);
  $('banners').hidden = rivers;

  // The spot name in the header belongs to the surf forecast, not to rivers.
  $('brandSub').textContent = rivers ? 'Whitewater — river levels' : activeSpot().name;

  if (rivers) {
    renderRivers({
      url: state.settings.rivers.url,
      frame: $('riverFrame'),
      openBtn: $('riverOpen'),
    });
    measureRivers();
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
}

// --- settings sheet --------------------------------------------------------

function openSettings() {
  $('settingsSheet').hidden = false;
  renderSettings($('settingsBody'), {
    settings: state.settings,
    onChange(next) {
      state.settings = next;
      persist();
      render();
    },
    async onReload() {
      await loadAll({ force: true });
    },
    async onConnectGoogle() {
      await refreshCalendar({ interactive: true });
      render();
      return state.calStatus;
    },
    listCalendars: () => cal.listCalendars(state.settings.google.clientId),
    onSignOut() {
      cal.clearToken();
      state.busy = [];
      state.calStatus = { state: 'off', message: 'Signed out of Google.' };
      render();
    },
    onReset() {
      state.settings = resetSettings();
      render();
      openSettings();
    },
    defaults: DEFAULT_SETTINGS,
  });
}

function closeSettings() { $('settingsSheet').hidden = true; }

// --- boot ------------------------------------------------------------------

function paintIcons() {
  for (const node of document.querySelectorAll('[data-icon]')) {
    const label = node.textContent.trim();
    node.innerHTML = iconHtml(node.dataset.icon);
    if (label) node.append(document.createTextNode(label));
  }
}

function wire() {
  paintIcons();
  for (const b of document.querySelectorAll('.nav__btn')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  $('refreshBtn').addEventListener('click', () => loadAll({ force: true }));
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('settingsSheet').addEventListener('click', (e) => {
    if (e.target === $('settingsSheet')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSettings(); ui.hideTooltip($('tooltip')); }
  });
  document.addEventListener('scroll', () => ui.hideTooltip($('tooltip')), { passive: true });
  window.addEventListener('resize', () => { if (state.view === 'rivers') measureRivers(); });

  // Re-render on wake so "now" doesn't silently drift while the app sits open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const fc = forecast();
      if (!fc || Date.now() - fc.fetchedAt > 30 * 60 * 1000) loadAll();
      else render();
    }
  });
  setInterval(() => { if (!state.selected) render(); }, 10 * 60 * 1000);
}

async function boot() {
  wire();
  setView('now');
  await loadAll();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch { /* not fatal */ }
  }
}

boot();
