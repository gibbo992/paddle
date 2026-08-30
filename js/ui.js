// Rendering. Every function takes state and writes into the DOM; none of them
// fetch or decide anything.

import {
  clamp, compass, mToFt, fmtClock, fmtDuration, round, dayKey,
} from './util.js';
import { iconHtml } from './icons.js';
import { ratingFor, RATINGS } from './scoring.js';
import { agreementLabel } from './sources.js';

/**
 * Score → colour, on a traffic-light STATUS scale rather than a sequential
 * ramp. RiverPredictor grades its levels green/yellow/orange/red and that page
 * is one tab away, so a second colour language in the same app would just be
 * confusing. Returns CSS variables so the scale can restep for dark mode.
 *
 * Every element that takes one of these also prints the rating word beside it,
 * so nothing depends on telling green from red.
 */
export function scoreColour(score) {
  if (!Number.isFinite(score)) return 'var(--surface-3)';
  return `var(--score-${ratingFor(score).tone})`;
}

/** Ink that clears contrast on that step, in either theme. */
export function scoreInk(score) {
  if (!Number.isFinite(score)) return 'var(--text-primary)';
  return `var(--score-${ratingFor(score).tone}-ink)`;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function iconEl(name, cls) {
  const span = document.createElement('span');
  span.innerHTML = iconHtml(name);
  const node = span.firstElementChild;
  if (cls) node.setAttribute('class', cls);
  return node;
}

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
  const R = 40;
  const C = 2 * Math.PI * R;
  const frac = clamp(res.score / 10, 0, 1);
  const colour = scoreColour(res.score);
  dial.innerHTML = `
    <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
      <circle cx="46" cy="46" r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="6"/>
      <circle cx="46" cy="46" r="${R}" fill="none" stroke="${colour}" stroke-width="6"
              stroke-linecap="round" stroke-dasharray="${C}"
              stroke-dashoffset="${C * (1 - frac)}"/>
    </svg>
    <div class="dial__val">
      <div class="dial__num">${res.score.toFixed(1)}</div>
    </div>`;

  const body = el('div', 'hero__body');
  body.append(
    el('div', 'hero__rating', res.rating.label),
    el('div', 'hero__verdict', verdict),
    el('div', 'hero__where',
      `${craft.short} · ${spot.short} · ${hour ? fmtClock(hour.time) : 'now'}`),
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
    n.append(el('div', 'stat__sub', sub || '\u00a0'));
    return n;
  };

  const period = Number.isFinite(res.period) ? `${Math.round(res.period)}s` : '--';
  const swellTxt = Number.isFinite(res.swellDir) ? compass(res.swellDir) : '--';

  // Wind: the relation matters more than the gust, so it gets the subtitle.
  const windSub = res.wind.relation === 'glassy'
    ? 'glassy'
    : `${compass(hour.windDirection)} ${res.wind.relation}`;

  const tideSub = Number.isFinite(hour.tideNorm) ? (hour.tideState || '') : '';

  // Ordered by how much each one decides whether you go.
  // When the models disagree, say by how much rather than quoting one figure
  // to a decimal place as if it were settled.
  let surfSub = 'face';
  if (Number.isFinite(hour.waveSpread) && hour.waveSpread > 0.2 && Number.isFinite(res.exposure)) {
    const lo = (res.hs - (hour.waveSpread * res.exposure) / 2) * res.faceFactor;
    const hi = (res.hs + (hour.waveSpread * res.exposure) / 2) * res.faceFactor;
    surfSub = `${fmtHeight(Math.max(0, lo), units)}–${fmtHeight(hi, units)}`;
  }

  grid.append(
    stat('Surf', fmtHeight(res.faceM, units), surfSub),
    stat('Period', period, `${swellTxt} swell`),
    stat('Wind', fmtWind(hour.windKn, units), windSub),
    stat('Tide', tidePct(hour.tideNorm), tideSub),
    stat('Sea', fmtTemp(hour.seaTemp), 'water'),
    stat('Air', fmtTemp(hour.airTemp),
      Number.isFinite(hour.apparentTemp) ? `feels ${fmtTemp(hour.apparentTemp)}` : ''),
  );
}

function tidePct(norm) {
  if (!Number.isFinite(norm)) return '--';
  if (norm >= 0.8) return 'High';
  if (norm <= 0.2) return 'Low';
  return `${Math.round(norm * 100)}%`;
}

// --- component breakdown ---------------------------------------------------

const PART_LABELS = {
  size: 'Size', power: 'Power', wind: 'Wind', direction: 'Direction', tide: 'Tide',
};

export function renderParts(list, explain, noteEl, { res, spot, craft }) {
  list.replaceChildren();

  // Weakest first. The limiting factor is the only actionable part of this
  // card — sorting best-first buried it below the fold.
  const entries = Object.entries(res.parts).sort((a, b) => a[1] - b[1]);
  const limiting = entries[0];

  for (const [key, val] of entries) {
    const row = el('div', `part${key === limiting[0] ? ' part--limiting' : ''}`);
    row.append(el('div', 'part__label', PART_LABELS[key] || key));

    const track = el('div', 'part__track');
    const fill = el('div', 'part__fill');
    fill.style.width = `${clamp(val, 0, 1) * 100}%`;
    // Neutral: these are component scores, not a verdict on the session.
    fill.style.background = 'var(--accent)';
    track.append(fill);

    row.append(track, el('div', 'part__val', `${Math.round(val * 100)}`));
    list.append(row);
  }

  if (noteEl) {
    noteEl.textContent = limiting[1] > 0.9
      ? 'nothing much'
      : `mostly ${(PART_LABELS[limiting[0]] || limiting[0]).toLowerCase()}`;
  }

  const bits = [];
  if (spot.shelter < 0.98 || res.exposure < 0.9) {
    bits.push(`${spot.short} sees about ${Math.round(res.exposure * 100)}% of the open-coast swell `
      + `(${fmtHeight(res.openCoastHs, { height: 'm' })} out at sea) once the headland and the swell angle have taken their cut.`);
  }
  bits.push(`Scored for a ${craft.name.toLowerCase()} — ${craft.blurb.toLowerCase()}.`);
  explain.textContent = bits.join(' ');
}

// --- flags -----------------------------------------------------------------

/** Model agreement, as a sentence. Blank when there is nothing to say. */
export function renderAgreement(el_, hour) {
  const { label, tone } = agreementLabel(hour.agreement, hour.modelCount);
  el_.textContent = label;
  el_.dataset.tone = tone;
}

export function renderFlags(root, flags) {
  root.replaceChildren();
  if (!flags.length) {
    const ok = el('div', 'flag flag--good');
    ok.append(iconEl('good'), el('span', null, 'Nothing out of the ordinary flagged.'));
    root.append(ok);
    return;
  }
  const order = { critical: 0, serious: 1, warning: 2, info: 3, good: 4 };
  for (const f of [...flags].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9))) {
    const n = el('div', `flag flag--${f.level}`);
    // Icon + text, never colour alone.
    n.append(iconEl(f.level), el('span', null, f.text));
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

const sentence = (t) => t.replace(/^./, (c) => c.toUpperCase());

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
    e.append(iconEl('shrug'));
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
    pill.style.color = scoreInk(w.mean);

    const mid = el('div');
    mid.style.minWidth = '0';
    mid.append(
      el('div', 'window__rule', `${sentence(dayLabel(w.start, now))} · ${w.ruleLabel}`),
      el('div', 'window__when', `${fmtClock(w.start)}–${fmtClock(w.end)} · ${w.spot.short}`),
      el('div', 'window__meta',
        `${fmtHeight(w.representative.faceM, units)} face · ${Math.round(w.representative.period)} s · ` +
        `${fmtWind(w.hour.windKn, units)} ${w.representative.wind.relation} · ${w.duration}`),
    );

    top.append(pill, mid);
    btn.append(top);
    btn.append(el('div', 'window__verdict', w.note));

    if (w.constrained) {
      const c = el('div', 'window__constrained');
      c.append(iconEl('calendar'), el('span', null, 'Trimmed to fit around your calendar'));
      btn.append(c);
    }

    btn.addEventListener('click', () => onPick(w));
    root.append(btn);
  }
}

// --- hourly forecast strip -------------------------------------------------

/**
 * Determine the hours worth showing. The old strip ran 00:00–23:00 and
 * scrolled, so you met six hours of darkness before reaching anything you'd
 * paddle in, and no two days lined up. Clipping to daylight gets a whole day
 * onto the screen at once, which makes the week comparable at a glance.
 */
function daylightRange(forecast) {
  let from = 24;
  let to = 0;
  for (const day of forecast.daily.values()) {
    if (day.sunrise) from = Math.min(from, day.sunrise.getHours());
    if (day.sunset) to = Math.max(to, day.sunset.getHours() + 1);
  }
  if (from > to) return { from: 6, to: 21 };
  // A shoulder either side: first and last light are rideable.
  return { from: clamp(from - 1, 0, 23), to: clamp(to + 1, 1, 24) };
}

export function renderDays(root, tableRoot, { forecast, spot, craft, scoredHours, now, units, onPick }) {
  root.replaceChildren();

  const { from, to } = daylightRange(forecast);
  const cutoff = new Date(+now - 3600e3);

  const byDay = new Map();
  for (const entry of scoredHours) {
    const t = entry.hour.time;
    if (t < cutoff) continue;
    const h = t.getHours();
    if (h < from || h >= to) continue;
    const k = dayKey(t);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(entry);
  }

  const span = to - from;

  for (const [key, entries] of byDay) {
    const day = el('div', 'day');
    const head = el('div', 'day__head');
    head.append(el('div', 'day__name', sentence(dayLabel(entries[0].hour.time, now))));

    // Lead with the day's verdict so the week is scannable without reading cells.
    const best = entries.reduce((a, b) => (b.res.score > a.res.score ? b : a));
    head.append(el('div', 'day__best',
      best.res.score >= 4
        ? `best ${best.res.score.toFixed(1)} at ${fmtClock(best.hour.time)}`
        : 'nothing worth it'));

    const meta = forecast.daily.get(key);
    if (meta?.sunrise && meta?.sunset) {
      const light = el('div', 'day__light');
      light.append(iconEl('sun'), document.createTextNode(`${fmtClock(meta.sunrise)}–${fmtClock(meta.sunset)}`));
      head.append(light);
    }
    day.append(head);

    const strip = el('div', 'strip');
    // Pad partial days (today starts late) so every day's columns line up.
    const present = new Map(entries.map((e) => [e.hour.time.getHours(), e]));
    for (let h = from; h < to; h++) {
      const entry = present.get(h);
      if (!entry) {
        const gap = el('div', 'cell');
        gap.style.visibility = 'hidden';
        gap.append(el('div', 'cell__bar'), el('div', 'cell__hr', ''));
        strip.append(gap);
        continue;
      }
      const { hour, res } = entry;
      const cell = el('button', 'cell');
      cell.type = 'button';
      cell.setAttribute('aria-label',
        `${fmtClock(hour.time)}, score ${res.score.toFixed(1)} out of 10, ${res.rating.label}`);

      const bar = el('div', 'cell__bar');
      const fill = el('div', 'cell__fill');
      fill.style.height = `${clamp(res.score / 10, 0.05, 1) * 100}%`;
      fill.style.background = scoreColour(res.score);
      bar.append(fill);

      // Label every third hour — one label per column is unreadable at this width.
      const showLabel = h % 3 === 0 || span <= 8;
      cell.append(bar, el('div', 'cell__hr', showLabel ? String(h).padStart(2, '0') : ''));
      cell.addEventListener('click', () => onPick(hour, res, cell));
      strip.append(cell);
    }
    day.append(strip);
    root.append(day);
  }

  if (!byDay.size) {
    root.append(el('div', 'empty', 'No daylight hours left in the forecast.'));
  }

  renderTable(tableRoot, scoredHours, now, units);
}

/** The table view — the non-colour route to the same numbers. */
function renderTable(root, scoredHours, now, units) {
  const rows = scoredHours
    .filter((e) => e.hour.time >= new Date(+now - 3600e3))
    .slice(0, 96);

  const head = ['Time', 'Score', 'Rating', 'Face', 'Swell (Hs)', 'Period', 'Wind', 'Tide', 'Air', 'Sea'];
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of head) hr.append(el('th', null, h));
  thead.append(hr);

  const tbody = el('tbody');
  for (const { hour, res } of rows) {
    const tr = el('tr');
    tr.append(
      el('td', null, `${sentence(dayLabel(hour.time, now))} ${fmtClock(hour.time)}`),
      el('td', null, res.score.toFixed(1)),
      el('td', null, res.rating.label),
      el('td', null, fmtHeight(res.faceM, units)),
      el('td', null, Number.isFinite(hour.waveHeight) ? `${round(hour.waveHeight, 2)} m` : '--'),
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
  // Named bands, not an unlabelled ramp: on a status scale the words are the
  // key, and they double as the non-colour route to the same information.
  for (const r of [...RATINGS].reverse()) {
    const item = el('span', 'legend__item');
    const sw = el('span', 'legend__sw');
    sw.style.background = `var(--score-${r.tone})`;
    item.append(sw, el('span', null, r.label));
    rampEl.append(item);
  }
  unitEl.textContent = `Face height in ${units.height === 'ft' ? 'feet' : 'metres'}`;
  unitEl.className = 'legend__unit';
}

// --- spot / craft selectors ------------------------------------------------

/** Craft picker: a segmented control, neutral so it never outshouts the data. */
export function renderCraft(root, items, activeId, onPick, scores) {
  root.replaceChildren();
  for (const it of items) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(it.id === activeId));
    b.append(el('span', null, it.short || it.name));
    const sc = scores?.get(it.id);
    if (Number.isFinite(sc)) b.append(el('span', 'seg__score', sc.toFixed(1)));
    b.addEventListener('click', () => onPick(it.id));
    root.append(b);
  }
}

/**
 * Spot picker. Each pill carries a ramp dot for its current score, so you can
 * see which beach is on without switching to it.
 */
export function renderSpots(root, items, activeId, onPick, scores) {
  root.replaceChildren();
  for (const it of items) {
    const b = el('button', 'spot');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(it.id === activeId));

    const sc = scores?.get(it.id);
    if (Number.isFinite(sc)) {
      const dot = el('span', 'spot__dot');
      dot.style.background = scoreColour(sc);
      b.append(dot);
    }
    b.append(document.createTextNode(it.short || it.name));
    if (Number.isFinite(sc)) b.append(el('span', 'spot__score', sc.toFixed(1)));

    b.addEventListener('click', () => onPick(it.id));
    root.append(b);
  }
}

/**
 * The "or should I wait?" line. Without it the highest-value fact in the app —
 * that Thursday dawn is a 9 and right now is a 5 — sits behind a tab.
 */
export function renderNextBest(root, best, { now, current, onPick }) {
  root.replaceChildren();
  if (!best) return;

  // Only worth interrupting for if it is meaningfully better than now.
  if (Number.isFinite(current) && best.mean < current + 0.8) {
    const note = el('div', 'hero__where');
    note.style.marginTop = '12px';
    note.textContent = 'Nothing materially better in your free hours this week.';
    root.append(note);
    return;
  }

  const btn = el('button', 'nextbest');
  btn.type = 'button';

  const pill = el('div', 'nextbest__pill', best.mean.toFixed(1));
  pill.style.background = scoreColour(best.mean);
  pill.style.color = scoreInk(best.mean);

  const body = el('div', 'nextbest__body');
  body.append(
    el('div', 'nextbest__label', 'Best in your free hours'),
    el('div', 'nextbest__when',
      `${sentence(dayLabel(best.start, now))} ${fmtClock(best.start)} · ${best.spot.short}`),
  );

  btn.append(pill, body, iconEl('arrowRight', 'nextbest__arrow'));
  btn.addEventListener('click', () => onPick(best));
  root.append(btn);
}

// --- banners & tooltip -----------------------------------------------------

export function renderBanners(root, banners) {
  root.replaceChildren();
  for (const b of banners) {
    const n = el('div', 'banner');
    n.append(iconEl(b.icon || 'info'), el('span', null, b.text));
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
