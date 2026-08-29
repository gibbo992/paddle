// The settings sheet. Kept separate from app.js because it is all form
// plumbing and none of it is interesting to the rest of the app.

import { SPOTS } from './spots.js';

const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function section(title) {
  const h = el('h3', null, title);
  h.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:22px 0 10px';
  return h;
}

export function renderSettings(root, ctx) {
  const s = structuredClone(ctx.settings);
  root.replaceChildren();

  const commit = () => ctx.onChange(structuredClone(s));

  // ---- units
  root.append(section('Units'));
  root.append(select('Wave height', s.units.height, [['ft', 'Feet'], ['m', 'Metres']], (v) => {
    s.units.height = v; commit();
  }));
  root.append(select('Wind speed', s.units.wind, [['kn', 'Knots'], ['mph', 'Miles per hour']], (v) => {
    s.units.wind = v; commit();
  }));

  // ---- spots
  root.append(section('Spots to compare'));
  const spotHint = el('p', 'field__hint', 'Best sessions are ranked across everything ticked here.');
  spotHint.style.marginTop = '-4px';
  root.append(spotHint);

  for (const spot of SPOTS) {
    const row = el('div', 'field field--row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.id = `spot-${spot.id}`;
    cb.checked = s.enabledSpots.includes(spot.id);
    cb.addEventListener('change', () => {
      s.enabledSpots = cb.checked
        ? [...new Set([...s.enabledSpots, spot.id])]
        : s.enabledSpots.filter((x) => x !== spot.id);
      if (!s.enabledSpots.length) { s.enabledSpots = [spot.id]; cb.checked = true; }
      commit();
    });
    const lab = el('label', null, spot.name);
    lab.htmlFor = cb.id;
    row.append(cb, lab);
    root.append(row);

    const note = el('p', 'field__hint', spot.notes);
    note.style.cssText = 'margin:-8px 0 12px 30px';
    root.append(note);
  }

  // ---- session shape
  root.append(section('When you can paddle'));
  for (const rule of s.rules) root.append(ruleEditor(rule, commit));

  root.append(number('Shortest session worth having (minutes)', s.minSessionMins, 30, 300, 15, (v) => {
    s.minSessionMins = v; commit();
  }, 'Includes changing and getting on the water.'));

  root.append(number('Travel buffer around calendar events (minutes)', s.travelMins, 0, 90, 5, (v) => {
    s.travelMins = v; commit();
  }, 'Kept clear either side of anything in your diary.'));

  root.append(number('Don’t show sessions below this score', s.minWindowScore, 0, 9, 0.5, (v) => {
    s.minWindowScore = v; commit();
  }, 'Lower it to see the marginal ones.'));

  const dl = el('div', 'field field--row');
  const dlcb = el('input');
  dlcb.type = 'checkbox';
  dlcb.id = 'daylightOnly';
  dlcb.checked = s.daylightOnly;
  dlcb.addEventListener('change', () => { s.daylightOnly = dlcb.checked; commit(); });
  const dllab = el('label', null, 'Daylight only');
  dllab.htmlFor = dlcb.id;
  dl.append(dlcb, dllab);
  root.append(dl);

  // ---- google calendar
  root.append(section('Google Calendar'));
  root.append(googleBlock(s, commit, ctx));

  // ---- actions
  root.append(section('Data'));
  const reload = el('button', 'btn btn--ghost', 'Refresh forecast now');
  reload.addEventListener('click', async () => {
    reload.disabled = true;
    reload.textContent = 'Refreshing…';
    await ctx.onReload();
    reload.disabled = false;
    reload.textContent = 'Refresh forecast now';
  });
  root.append(reload);

  const reset = el('button', 'btn btn--danger', 'Reset all settings');
  reset.addEventListener('click', () => {
    if (confirm('Reset every setting back to the defaults?')) ctx.onReset();
  });
  root.append(reset);

  const about = el('p', 'field__hint');
  about.style.marginTop = '18px';
  about.textContent = 'Forecast data from Open-Meteo. Spot tuning (swell windows, tide preferences) '
    + 'lives in js/spots.js — edit it if the app disagrees with what you find on the beach.';
  root.append(about);
}

// --- controls --------------------------------------------------------------

function select(label, value, options, onChange) {
  const f = el('div', 'field');
  const l = el('label', null, label);
  const sel = el('select');
  for (const [v, t] of options) {
    const o = el('option', null, t);
    o.value = v;
    if (v === value) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  l.htmlFor = sel.id = `sel-${label.replace(/\W+/g, '-').toLowerCase()}`;
  f.append(l, sel);
  return f;
}

function number(label, value, min, max, step, onChange, hint) {
  const f = el('div', 'field');
  const l = el('label', null, label);
  const inp = el('input');
  inp.type = 'number';
  inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  inp.inputMode = 'decimal';
  inp.addEventListener('change', () => {
    const v = Number(inp.value);
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
  });
  l.htmlFor = inp.id = `num-${label.replace(/\W+/g, '-').toLowerCase()}`;
  f.append(l, inp);
  if (hint) f.append(el('p', 'field__hint', hint));
  return f;
}

function ruleEditor(rule, commit) {
  const box = el('div', 'ruleedit');

  const head = el('div', 'field field--row');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.id = `rule-${rule.id}`;
  cb.checked = rule.enabled;
  cb.addEventListener('change', () => { rule.enabled = cb.checked; commit(); });
  const lab = el('label', null, rule.label);
  lab.htmlFor = cb.id;
  lab.style.fontWeight = '600';
  head.append(cb, lab);
  box.append(head);

  const times = el('div', 'times');
  const from = el('input');
  from.type = 'time';
  from.value = rule.start;
  from.addEventListener('change', () => { rule.start = from.value; commit(); });
  const to = el('input');
  to.type = 'time';
  to.value = rule.end;
  to.addEventListener('change', () => { rule.end = to.value; commit(); });
  times.append(from, el('span', 'muted', 'to'), to);
  box.append(times);

  const days = el('div', 'dayspick');
  for (let d = 0; d < 7; d++) {
    const b = el('button', null, DAY_NAMES[d]);
    b.type = 'button';
    b.title = DAY_FULL[d];
    b.setAttribute('aria-label', DAY_FULL[d]);
    b.setAttribute('aria-pressed', String(rule.days.includes(d)));
    b.addEventListener('click', () => {
      rule.days = rule.days.includes(d) ? rule.days.filter((x) => x !== d) : [...rule.days, d].sort();
      b.setAttribute('aria-pressed', String(rule.days.includes(d)));
      commit();
    });
    days.append(b);
  }
  box.append(days);
  return box;
}

// --- google ----------------------------------------------------------------

function googleBlock(s, commit, ctx) {
  const wrap = el('div');

  const intro = el('p', 'field__hint');
  intro.style.marginTop = '-4px';
  intro.textContent = 'Optional. With it connected, sessions clashing with your diary are dropped '
    + 'and part-free evenings get trimmed to the time you actually have. Everything stays in this '
    + 'browser — there is no server to send it to.';
  wrap.append(intro);

  const toggle = el('div', 'field field--row');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.id = 'gcal-enabled';
  cb.checked = s.google.enabled;
  cb.addEventListener('change', () => { s.google.enabled = cb.checked; commit(); });
  const lab = el('label', null, 'Use my Google Calendar');
  lab.htmlFor = cb.id;
  toggle.append(cb, lab);
  wrap.append(toggle);

  const idField = el('div', 'field');
  const idLab = el('label', null, 'OAuth client ID');
  const idInp = el('input');
  idInp.type = 'text';
  idInp.placeholder = '…apps.googleusercontent.com';
  idInp.value = s.google.clientId;
  idInp.autocomplete = 'off';
  idInp.spellcheck = false;
  idInp.addEventListener('change', () => { s.google.clientId = idInp.value.trim(); commit(); });
  idLab.htmlFor = idInp.id = 'gcal-client-id';
  idField.append(idLab, idInp);
  idField.append(el('p', 'field__hint',
    'You create this once in Google Cloud Console — see "Connecting Google Calendar" in the README. '
    + 'It is not a secret and it only works from this site’s address.'));
  wrap.append(idField);

  const status = el('p', 'field__hint');
  wrap.append(status);

  const connect = el('button', 'btn btn--ghost', 'Sign in and pick calendars');
  connect.addEventListener('click', async () => {
    if (!s.google.clientId) { status.textContent = 'Add a client ID first.'; return; }
    connect.disabled = true;
    connect.textContent = 'Opening Google…';
    try {
      const cals = await ctx.listCalendars();
      renderCalendarPicker(list, cals, s, commit);
      status.textContent = `Found ${cals.length} calendar${cals.length === 1 ? '' : 's'}.`;
      await ctx.onConnectGoogle();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      connect.disabled = false;
      connect.textContent = 'Sign in and pick calendars';
    }
  });
  wrap.append(connect);

  const list = el('div');
  list.style.marginTop = '12px';
  wrap.append(list);

  if (s.google.calendarIds.length) {
    const chosen = el('p', 'field__hint',
      `Currently using ${s.google.calendarIds.length} calendar${s.google.calendarIds.length === 1 ? '' : 's'}. `
      + 'Sign in again to change the selection.');
    list.append(chosen);
  }

  const out = el('button', 'btn btn--danger', 'Sign out of Google');
  out.addEventListener('click', () => {
    ctx.onSignOut();
    status.textContent = 'Signed out.';
  });
  wrap.append(out);

  return wrap;
}

function renderCalendarPicker(root, cals, s, commit) {
  root.replaceChildren();
  root.append(el('p', 'field__hint', 'Tick the calendars that mean “I am busy”.'));

  for (const c of cals) {
    const row = el('div', 'field field--row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.id = `cal-${btoa(c.id).replace(/=/g, '')}`;
    cb.checked = s.google.calendarIds.includes(c.id);
    cb.addEventListener('change', () => {
      s.google.calendarIds = cb.checked
        ? [...new Set([...s.google.calendarIds, c.id])]
        : s.google.calendarIds.filter((x) => x !== c.id);
      commit();
    });
    const lab = el('label', null, c.name + (c.primary ? ' (main)' : ''));
    lab.htmlFor = cb.id;
    row.append(cb, lab);
    root.append(row);
  }
}
