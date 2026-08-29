// Rendering. Every function takes state and writes into the DOM; none of them
// fetch or decide anything.

import {
  clamp, compass, mToFt, fmtClock, fmtDuration, round, dayKey,
} from './util.js';
import { FACE_FACTOR } from './scoring.js';

// Sequential blue ramp, light → dark: magnitude of score.
// One hue, never a rainbow — the rating word beside it carries the meaning, so
// nothing here depends on telling red from green.
const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

/** Score 0..10 → a ramp step. Low scores use the pale end so they recede. */
export function scoreColour(score) {
  if (!Number.isFinite(score)) return 'var(--surface-3)';
  const t = clamp(score / 10, 0, 1);
  // Invert: a high score should be the saturated, dark end of the ramp.
  return SEQ[Math.min(SEQ.length - 1, Math.round(t * (SEQ.length - 1)))];
}

/** Ink that stays legible on a given ramp step. */
export function inkOn(score) {
  return Number.isFinite(score) && score >= 4.3 ? '#ffffff' : '#0b0b0b';
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const FLAG_ICONS = {
  critical: '⛔', serious: '⚠️', warning: '⚠️', info: 'ℹ️', good: '✓',
};

// --- unit helpers ----------------------------------------------------------

export function fmtHeight(metres, units) {
  if (!Number.isFinite(metres)) return '--';
  return units.height === 'ft' ? `${round(mToFt(metres), 1)} ft` : `${round(metres, 1)} m`;
}

export function fmtWind(kn, units) {
  if (!Number.isFinite(kn)) return '--';
  return units.wind === 'mph' ? `${Math.round(kn * 1.15078)} mph` : `${Math.round(kn)} kn`;
}

const fmtTemp = (c) => (Number.isFinite(c) ? `${Math.round(c)}°` : '--');

// --- hero ------------------------------------------------------------------

export function renderHero(root, { res, spot, craft, hour, verdict, units }) {
  root.replaceChildren();
  const wrap = el('div', 'hero');

  // Dial: a meter, so the track is a lighter step of the same ramp.
  const dial = el('div', 'dial');
  const R = 50;
  const C = 2 * Math.PI * R;
  const frac = clamp(res.score / 10, 0, 1);
  const colour = scoreColour(res.score);
  dial.innerHTML = `
    <svg width="116" height="116" viewBox="0 0 116 116" aria-hidden="true">
      <circle cx="58" cy="58" r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="9"/>
      <circle cx="58" cy="58" r="${R}" fill="none" stroke="${colour}" stroke-width="9"
              stroke-linecap="round" stroke-dasharray="${C}"
              stroke-dashoffset="${C * (1 - frac)}"/>
    </svg>
    <div class="dial__val">
      <div class="dial__num">${res.score.toFixed(1)}</div>
      <div class="dial__den">out of 10</div>
    </div>`;

  const body = el('div', 'hero__body');
  body.append(
    el('div', 'hero__rating', res.rating.label),
    el('div', 'hero__verdict', verdict),
    el('div', 'hero__where',
      `${craft.icon} ${craft.name} · ${spot.name} · ${hour ? fmtClock(hour.time) : 'now'}`),
  );

  wrap.append(dial, body);
  root.append(wrap);
}

// --- stat grid -------------------------------------------------------------

export function renderStats(grid, { res, hour, units, tideRegime }) {
  grid.replaceChildren();

  const stat = (label, value, sub) => {
    const n = el('div', 'stat');
    n.append(el('div', 'stat__label', label), el('div', 'stat__value', value));
    if (sub) n.append(el('div', 'stat__sub', sub));
    return n;
  };

  const period = Number.isFinite(res.period) ? `${Math.round(res.period)} s` : '--';
  const swellTxt = Number.isFinite(res.swellDir)
    ? `${compass(res.swellDir)} ${Math.round(res.swellDir)}°` : '--';

  const windSub = res.wind.relation === 'glassy'
    ? 'glassy'
    : `${compass(hour.windDirection)} · ${res.wind.relation}`;

  const gust = Number.isFinite(hour.windGustKn) ? `gusts ${fmtWind(hour.windGustKn, units)}` : null;

  const tideSub = Number.isFinite(hour.tideNorm)
    ? `${hour.tideState}${tideRegime?.label && tideRegime.label !== 'unknown' ? ` · ${tideRegime.label}` : ''}`
    : '';

  grid.append(
    stat('Surf', fmtHeight(res.faceM, units), `face · ${fmtHeight(res.hs, units)} swell`),
    stat('Period', period, swellTxt),
    stat('Wind', fmtWind(hour.windKn, units), gust || windSub),
    stat('Tide', tidePct(hour.tideNorm), tideSub),
    stat('Air', fmtTemp(hour.airTemp), Number.isFinite(hour.apparentTemp) ? `feels ${fmtTemp(hour.apparentTemp)}` : ''),
    stat('Sea', fmtTemp(hour.seaTemp), 'water'),
  );

  if (res.wind.relation !== 'glassy' && gust) {
    // The relation is the thing you actually care about — don't lose it to gusts.
    grid.children[2].append(el('div', 'stat__sub', windSub));
  }
}

function tidePct(norm) {
  if (!Number.isFinite(norm)) return '--';
  if (norm > 0.85) return 'High';
  if (norm < 0.15) return 'Low';
  return `${Math.round(norm * 100)}%`;
}

// --- component breakdown ---------------------------------------------------

const PART_LABELS = {
  size: 'Size', power: 'Power', wind: 'Wind', direction: 'Direction', tide: 'Tide',
};

export function renderParts(list, explain, { res, spot, craft }) {
  list.replaceChildren();
  const entries = Object.entries(res.parts).sort((a, b) => b[1] - a[1]);

  for (const [key, val] of entries) {
    const row = el('div', 'part');
    row.append(el('div', 'part__label', PART_LABELS[key] || key));

    const track = el('div', 'part__track');
    const fill = el('div', 'part__fill');
    fill.style.width = `${clamp(val, 0, 1) * 100}%`;
    fill.style.background = scoreColour(val * 10);
    track.append(fill);

    row.append(track, el('div', 'part__val', `${Math.round(val * 100)}`));
    list.append(row);
  }

  const bits = [];
  if (spot.shelter < 0.98) {
    bits.push(`${spot.short} sits behind the headland, so it sees about ` +
      `${Math.round(res.exposure * 100)}% of the open-coast swell (${fmtHeight(res.openCoastHs, { height: 'm' })} out at sea today).`);
  }
  bits.push(`Scored for a ${craft.name.toLowerCase()} — ${craft.blurb.toLowerCase()}.`);
  explain.textContent = bits.join(' ');
}

// --- flags -----------------------------------------------------------------

export function renderFlags(root, flags) {
  root.replaceChildren();
  if (!flags.length) {
    const ok = el('div', 'flag flag--good');
    ok.append(el('span', 'flag__icon', '✓'), el('span', null, 'Nothing out of the ordinary flagged.'));
    root.append(ok);
    return;
  }
  const order = { critical: 0, serious: 1, warning: 2, info: 3, good: 4 };
  for (const f of [...flags].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9))) {
    const n = el('div', `flag flag--${f.level}`);
    // Icon + text, never colour alone.
    n.append(el('span', 'flag__icon', FLAG_ICONS[f.level] || 'ℹ️'), el('span', null, f.text));
    root.append(n);
  }
}

// --- kit -------------------------------------------------------------------

export function renderKit(suitEl, extrasEl, chillEl, noteEl, kit) {
  suitEl.textContent = kit.suit;
  extrasEl.replaceChildren();
  for (const e of kit.extras) extrasEl.append(el('span', 'chip', e));
  for (const a of kit.always) extrasEl.append(el('span', 'chip chip--always', a));
  chillEl.textContent = kit.chillNote || '';
  chillEl.hidden = !kit.chillNote;
  noteEl.textContent = Number.isFinite(kit.seaTempC) ? `sea ${Math.round(kit.seaTempC)}°C` : '';
}

// --- tide chart ------------------------------------------------------------

export function renderTide(svg, eventsEl, noteEl, { forecast, now, units }) {
  const W = 680;
  const H = 92;
  const padY = 14;

  const from = new Date(+now - 2 * 3600e3);
  const to = new Date(+now + 22 * 3600e3);
  const pts = forecast.hours.filter((h) => h.time >= from && h.time <= to && Number.isFinite(h.seaLevel));
  if (pts.length < 3) { svg.replaceChildren(); return; }

  const lo = Math.min(...pts.map((p) => p.seaLevel));
  const hi = Math.max(...pts.map((p) => p.seaLevel));
  const span = Math.max(0.2, hi - lo);

  const x = (t) => ((t - from) / (to - from)) * W;
  const y = (v) => padY + (1 - (v - lo) / span) * (H - padY * 2);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.seaLevel).toFixed(1)}`).join('');
  const area = `${line}L${x(pts[pts.length - 1].time).toFixed(1)},${H}L${x(pts[0].time).toFixed(1)},${H}Z`;

  const nowX = x(now);
  const nowPt = pts.reduce((a, b) => (Math.abs(b.time - now) < Math.abs(a.time - now) ? b : a));

  // Hour ticks every 6 h — recessive, solid hairlines.
  let ticks = '';
  for (let t = +from; t <= +to; t += 6 * 3600e3) {
    const d = new Date(t);
    if (d.getHours() % 6 !== 0) continue;
    ticks += `<line class="tide__grid" x1="${x(d).toFixed(1)}" y1="${padY - 6}" x2="${x(d).toFixed(1)}" y2="${H - 2}"/>` +
      `<text class="tide__label" x="${(x(d) + 4).toFixed(1)}" y="${H - 3}">${fmtClock(d)}</text>`;
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `
    ${ticks}
    <path class="tide__area" d="${area}"/>
    <path class="tide__line" d="${line}"/>
    <line class="tide__now" x1="${nowX.toFixed(1)}" y1="${padY - 8}" x2="${nowX.toFixed(1)}" y2="${H - 2}"/>
    <circle class="tide__dot" cx="${x(nowPt.time).toFixed(1)}" cy="${y(nowPt.seaLevel).toFixed(1)}" r="4.5"/>`;

  // Upcoming high and low waters.
  eventsEl.replaceChildren();
  const upcoming = forecast.tideEvents.filter((e) => e.time >= new Date(+now - 3600e3)).slice(0, 6);
  for (const e of upcoming) {
    const n = el('div', 'tideevent');
    n.append(
      el('span', null, e.kind === 'high' ? 'High water' : 'Low water'),
      el('b', null, fmtClock(e.time)),
      el('span', null, dayLabel(e.time, now)),
    );
    eventsEl.append(n);
  }

  const regime = forecast.tideRegime?.forDate(now);
  noteEl.textContent = regime && Number.isFinite(regime.rangeM)
    ? `${regime.label} · ${regime.rangeM.toFixed(1)} m range` : '';
}

function dayLabel(date, now) {
  const a = dayKey(date);
  const b = dayKey(now);
  if (a === b) return 'today';
  const t = new Date(+now + 86400e3);
  if (a === dayKey(t)) return 'tomorrow';
  return date.toLocaleDateString('en-GB', { weekday: 'short' });
}

// --- best windows ----------------------------------------------------------

export function renderWindows(root, windows, { now, units, onPick }) {
  root.replaceChildren();

  if (!windows.length) {
    const e = el('div', 'empty');
    e.append(el('span', 'empty__big', '🤷'));
    e.append(el('div', null, 'Nothing worth paddling in your free hours over the next week.'));
    e.append(el('div', 'muted',
      'Widen your session times or drop the minimum score in Settings if you want to see the marginal ones.'));
    root.append(e);
    return;
  }

  for (const w of windows) {
    const btn = el('button', 'window');
    btn.type = 'button';

    const top = el('div', 'window__top');
    const pill = el('div', 'window__pill', w.mean.toFixed(1));
    pill.style.background = scoreColour(w.mean);
    pill.style.color = inkOn(w.mean);

    const mid = el('div');
    mid.style.minWidth = '0';
    mid.append(
      el('div', 'window__rule', `${dayLabel(w.start, now)} · ${w.ruleLabel}`),
      el('div', 'window__when', `${fmtClock(w.start)}–${fmtClock(w.end)} · ${w.spot.short}`),
      el('div', 'window__meta',
        `${fmtHeight(w.representative.faceM, units)} face · ${Math.round(w.representative.period)} s · ` +
        `${fmtWind(w.hour.windKn, units)} ${w.representative.wind.relation} · ${w.duration}`),
    );

    top.append(pill, mid);
    btn.append(top);
    btn.append(el('div', 'window__verdict', w.verdict));

    if (w.constrained) {
      const c = el('div', 'window__constrained');
      c.append(el('span', null, '📅'), el('span', null, 'Trimmed to fit around your calendar'));
      btn.append(c);
    }

    btn.addEventListener('click', () => onPick(w));
    root.append(btn);
  }
}

// --- hourly forecast strip -------------------------------------------------

export function renderDays(root, tableRoot, { forecast, spot, craft, scoredHours, now, units, onPick }) {
  root.replaceChildren();

  const byDay = new Map();
  for (const entry of scoredHours) {
    if (entry.hour.time < new Date(+now - 3600e3)) continue;
    const k = dayKey(entry.hour.time);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(entry);
  }

  for (const [key, entries] of byDay) {
    const day = el('div', 'day');
    const head = el('div', 'day__head');
    head.append(el('div', 'day__name', dayLabel(entries[0].hour.time, now).replace(/^./, (c) => c.toUpperCase())));

    const meta = forecast.daily.get(key);
    if (meta?.sunrise && meta?.sunset) {
      head.append(el('div', 'day__light', `☀ ${fmtClock(meta.sunrise)} – ${fmtClock(meta.sunset)}`));
    }
    day.append(head);

    const strip = el('div', 'strip');
    for (const { hour, res } of entries) {
      const cell = el('button', `cell${hour.daylight === false ? ' cell--dark' : ''}`);
      cell.type = 'button';
      cell.setAttribute('aria-label',
        `${fmtClock(hour.time)}, score ${res.score.toFixed(1)} out of 10, ${res.rating.label}`);

      const bar = el('div', 'cell__bar');
      const fill = el('div', 'cell__fill');
      fill.style.height = `${clamp(res.score / 10, 0.04, 1) * 100}%`;
      fill.style.background = scoreColour(res.score);
      bar.append(fill);

      cell.append(bar, el('div', 'cell__hr', String(hour.time.getHours()).padStart(2, '0')));
      cell.addEventListener('click', () => onPick(hour, res, cell));
      strip.append(cell);
    }
    day.append(strip);
    root.append(day);
  }

  renderTable(tableRoot, scoredHours, now, units);
}

/** The table view — the non-colour route to the same numbers. */
function renderTable(root, scoredHours, now, units) {
  const rows = scoredHours
    .filter((e) => e.hour.time >= new Date(+now - 3600e3))
    .slice(0, 96);

  const head = ['Time', 'Score', 'Rating', 'Face', 'Period', 'Wind', 'Tide', 'Air', 'Sea'];
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of head) hr.append(el('th', null, h));
  thead.append(hr);

  const tbody = el('tbody');
  for (const { hour, res } of rows) {
    const tr = el('tr');
    tr.append(
      el('td', null, `${dayLabel(hour.time, now)} ${fmtClock(hour.time)}`),
      el('td', null, res.score.toFixed(1)),
      el('td', null, res.rating.label),
      el('td', null, fmtHeight(res.faceM, units)),
      el('td', null, Number.isFinite(res.period) ? `${Math.round(res.period)} s` : '--'),
      el('td', null, `${fmtWind(hour.windKn, units)} ${compass(hour.windDirection)}`),
      el('td', null, tidePct(hour.tideNorm)),
      el('td', null, fmtTemp(hour.airTemp)),
      el('td', null, fmtTemp(hour.seaTemp)),
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  root.replaceChildren(table);
}

export function renderLegend(rampEl, unitEl, units) {
  rampEl.replaceChildren();
  for (const c of SEQ) {
    const sw = el('span', 'legend__sw');
    sw.style.background = c;
    rampEl.append(sw);
  }
  unitEl.textContent = `Heights in ${units.height === 'ft' ? 'feet' : 'metres'} (breaking face)`;
}

// --- spot / craft selectors ------------------------------------------------

export function renderSegs(root, items, activeId, onPick, scores) {
  root.replaceChildren();
  for (const it of items) {
    const b = el('button', 'seg');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(it.id === activeId));
    b.append(document.createTextNode(`${it.icon ? `${it.icon} ` : ''}${it.short || it.name}`));

    const s = scores?.get(it.id);
    if (Number.isFinite(s)) b.append(el('span', 'seg__score', s.toFixed(1)));

    b.addEventListener('click', () => onPick(it.id));
    root.append(b);
  }
}

// --- banners & tooltip -----------------------------------------------------

export function renderBanners(root, banners) {
  root.replaceChildren();
  for (const b of banners) {
    const n = el('div', 'banner');
    n.append(el('span', null, b.icon || 'ℹ️'), el('span', null, b.text));
    root.append(n);
  }
}

let tipTimer = null;

export function showTooltip(tipEl, anchor, { hour, res, units }) {
  tipEl.replaceChildren();
  tipEl.append(el('b', null, `${fmtClock(hour.time)} · ${res.score.toFixed(1)}/10 ${res.rating.label}`));

  const dl = el('dl');
  const add = (k, v) => { dl.append(el('dt', null, k), el('dd', null, v)); };
  add('Face', fmtHeight(res.faceM, units));
  add('Period', Number.isFinite(res.period) ? `${Math.round(res.period)} s` : '--');
  add('Swell', Number.isFinite(res.swellDir) ? compass(res.swellDir) : '--');
  add('Wind', `${fmtWind(hour.windKn, units)} ${compass(hour.windDirection)}`);
  add('Tide', `${tidePct(hour.tideNorm)} ${hour.tideState || ''}`);
  add('Air / sea', `${fmtTemp(hour.airTemp)} / ${fmtTemp(hour.seaTemp)}`);
  tipEl.append(dl);

  tipEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  tipEl.style.left = `${clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8)}px`;
  const above = r.top > tipEl.offsetHeight + 16;
  tipEl.style.top = above ? `${r.top - tipEl.offsetHeight - 8}px` : `${r.bottom + 8}px`;

  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => { tipEl.hidden = true; }, 4200);
}

export function hideTooltip(tipEl) {
  clearTimeout(tipTimer);
  tipEl.hidden = true;
}
