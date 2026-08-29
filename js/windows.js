// Finds the sessions worth driving to: intersect the times you paddle with
// daylight, subtract what the calendar says you're busy with, then score what
// is left and rank it across every spot you have switched on.

import { scoreHour, limitingFactor } from './scoring.js';
import { parseHHMM, dayKey, fmtDuration } from './util.js';

const MIN = 60 * 1000;

// --- interval algebra ------------------------------------------------------

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

export function intersect(a, b) {
  const start = Math.max(+a.start, +b.start);
  const end = Math.min(+a.end, +b.end);
  return end > start ? { start: new Date(start), end: new Date(end) } : null;
}

/** Remove every `busy` interval from `base`, returning the surviving pieces. */
export function subtract(base, busies) {
  let pieces = [base];
  for (const busy of busies) {
    const next = [];
    for (const p of pieces) {
      if (!overlaps(p, busy)) { next.push(p); continue; }
      if (busy.start > p.start) next.push({ start: p.start, end: new Date(Math.min(+busy.start, +p.end)) });
      if (busy.end < p.end) next.push({ start: new Date(Math.max(+busy.end, +p.start)), end: p.end });
    }
    pieces = next.filter((p) => p.end > p.start);
  }
  return pieces;
}

// --- candidate slots -------------------------------------------------------

/**
 * Expand the session rules into dated intervals across the forecast range,
 * clipped to daylight.
 */
export function candidateSlots(forecast, settings, { now = new Date() } = {}) {
  const slots = [];
  const days = [...forecast.daily.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [key, day] of days) {
    const date = day.date;
    const dow = date.getDay(); // 0 = Sunday

    for (const rule of settings.rules) {
      if (!rule.enabled) continue;
      if (!rule.days.includes(dow)) continue;

      const s = parseHHMM(rule.start);
      const e = parseHHMM(rule.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;

      const base = {
        start: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0),
        end: null,
      };
      base.start = new Date(+base.start + s * MIN);
      base.end = new Date(+base.start + (e - s) * MIN);

      // Daylight is a hard bound — you are not paddling out in the dark.
      let clipped = base;
      if (settings.daylightOnly && day.lightFrom && day.lightTo) {
        clipped = intersect(base, { start: day.lightFrom, end: day.lightTo });
      }
      if (!clipped) continue;
      if (clipped.end <= now) continue;
      if (clipped.start < now) clipped = { start: new Date(now), end: clipped.end };
      if (clipped.end - clipped.start < settings.minSessionMins * MIN) continue;

      slots.push({
        ...clipped,
        ruleId: rule.id,
        ruleLabel: rule.label,
        dayKey: key,
        sunrise: day.sunrise,
        sunset: day.sunset,
      });
    }
  }
  return slots;
}

/** Pad each busy block by travel time so you can actually make the next thing. */
export function applyBusy(slots, busy, travelMins) {
  if (!busy?.length) return slots.map((s) => ({ ...s, pieces: [{ start: s.start, end: s.end }] }));

  const padded = busy.map((b) => ({
    start: new Date(+b.start - travelMins * MIN),
    end: new Date(+b.end + travelMins * MIN),
    summary: b.summary,
  }));

  return slots.map((s) => ({ ...s, pieces: subtract({ start: s.start, end: s.end }, padded) }));
}

// --- scoring a stretch of time --------------------------------------------

function hoursWithin(forecast, start, end) {
  return forecast.hours.filter((h) => h.time >= new Date(+start - 30 * MIN) && h.time < end);
}

/**
 * Best contiguous session inside `piece` at one spot.
 * Slides a minimum-length window for the best mean, then grows it outward while
 * the conditions hold up, so the reported window is the real one, not a stub.
 */
export function bestWindowIn(piece, forecast, spot, craft, settings) {
  const hrs = hoursWithin(forecast, piece.start, piece.end);
  if (!hrs.length) return null;

  const scored = hrs.map((h) => ({ h, res: scoreHour(h, spot, craft) }));
  const need = Math.max(1, Math.round(settings.minSessionMins / 60));
  if (scored.length < need) return null;

  let best = null;
  for (let i = 0; i + need <= scored.length; i++) {
    const slice = scored.slice(i, i + need);
    const m = slice.reduce((a, x) => a + x.res.score, 0) / slice.length;
    if (!best || m > best.mean) best = { i, mean: m };
  }
  if (!best) return null;

  // Grow while neighbouring hours are still worth being out for.
  const keep = Math.max(4.2, best.mean * 0.8);
  let lo = best.i;
  let hi = best.i + need - 1;
  while (lo > 0 && scored[lo - 1].res.score >= keep) lo--;
  while (hi < scored.length - 1 && scored[hi + 1].res.score >= keep) hi++;

  const window = scored.slice(lo, hi + 1);
  const mean = window.reduce((a, x) => a + x.res.score, 0) / window.length;
  const peak = window.reduce((a, x) => Math.max(a, x.res.score), 0);
  const peakEntry = window.find((x) => x.res.score === peak);

  // Round to 5 minutes — an end time of 20:23 reads like a bug, not a forecast.
  const round5 = (ms, dir) => {
    const step = 5 * MIN;
    return new Date(dir < 0 ? Math.ceil(ms / step) * step : Math.floor(ms / step) * step);
  };
  const start = round5(Math.max(+piece.start, +window[0].h.time), -1);
  const end = round5(Math.min(+piece.end, +window[window.length - 1].h.time + 60 * MIN), 1);
  const durationMins = Math.round((end - start) / MIN);
  if (durationMins < settings.minSessionMins) return null;

  return {
    start,
    end,
    durationMins,
    duration: fmtDuration(durationMins),
    spot,
    craft,
    mean,
    peak,
    peakAt: peakEntry?.h.time ?? start,
    representative: peakEntry?.res ?? window[0].res,
    hour: peakEntry?.h ?? window[0].h,
    hours: window,
    note: sessionNote(peakEntry?.res ?? window[0].res, craft),
  };
}

/**
 * What to say about one session in a ranked list. A generic "go now" repeated
 * down ten rows is filler; this says what is actually notable about each.
 */
function sessionNote(res, craft) {
  const serious = res.flags.find((f) => f.level === 'critical' || f.level === 'serious');
  if (serious) return serious.text;

  const { val, label } = limitingFactor(res, craft);
  if (res.score < 4) return `Not much in it — ${label}.`;
  if (val < 0.55) return `Worth a go, but ${label}.`;
  if (val < 0.8) return `Solid, though ${label}.`;

  // Nothing is against it — so say what actually stands out. A stock
  // "nothing against it" repeated down ten rows tells you nothing.
  if (res.wind.relation === 'glassy') return 'Glassy — not a breath on it.';
  if (res.period >= 11) return 'Long-period groundswell, and clean with it.';
  if (res.wind.relation === 'offshore' && -res.wind.onshoreKn >= 8) {
    return 'Groomed by the offshore — clean faces to work with.';
  }
  if (craft.id === 'ww-kayak') return 'Short, punchy and forgiving — good river-boat surf.';
  if (res.parts.size > 0.95) return 'Bang on size for the boat.';
  return 'Nothing against it the whole way through.';
}

/**
 * The headline feature: rank sessions across the next few days.
 *
 * @param {Map<string,object>} forecasts  spotId → forecast
 * @param {Array} spots  spots to consider
 */
export function findBestWindows(forecasts, spots, craft, settings, { busy = [], now = new Date(), limit = 8 } = {}) {
  const anyForecast = forecasts.get(spots[0]?.id) || [...forecasts.values()][0];
  if (!anyForecast) return [];

  const slots = applyBusy(candidateSlots(anyForecast, settings, { now }), busy, settings.travelMins);
  const results = [];

  for (const slot of slots) {
    for (const piece of slot.pieces) {
      if (piece.end - piece.start < settings.minSessionMins * MIN) continue;

      // Score every spot over the same free time and keep the best one.
      let bestHere = null;
      for (const spot of spots) {
        const fc = forecasts.get(spot.id);
        if (!fc) continue;
        const w = bestWindowIn(piece, fc, spot, craft, settings);
        if (w && (!bestHere || w.mean > bestHere.mean)) bestHere = w;
      }
      if (!bestHere) continue;
      if (bestHere.mean < settings.minWindowScore) continue;

      results.push({
        ...bestHere,
        ruleLabel: slot.ruleLabel,
        ruleId: slot.ruleId,
        dayKey: slot.dayKey,
        constrained: slot.pieces.length > 1 || +piece.start !== +slot.start || +piece.end !== +slot.end,
      });
    }
  }

  // One entry per rule-instance — the best of it, not three overlapping variants.
  const byKey = new Map();
  for (const r of results) {
    const k = `${r.dayKey}:${r.ruleId}`;
    const prev = byKey.get(k);
    if (!prev || r.mean > prev.mean) byKey.set(k, r);
  }

  return [...byKey.values()]
    .sort((a, b) => b.mean - a.mean || a.start - b.start)
    .slice(0, limit);
}
