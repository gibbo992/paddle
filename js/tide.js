// Tide state derived from Open-Meteo's hourly `sea_level_height_msl` series.
//
// This is a tide *model*, not the Admiralty tables. It is plenty good enough to
// answer "is it near high water and is it pushing or dropping", which is what
// the scoring needs. Do not navigate off it.

import { clamp } from './util.js';

const CYCLE_H = 12.42;          // M2 semidiurnal period
const HALF_WINDOW = Math.round(CYCLE_H / 2); // ±6h brackets one high and one low

/**
 * Annotate each hourly sample with a normalised height and a rising/falling state.
 * @param {Array<{time: Date, seaLevel: number}>} series hourly, ascending
 * @returns {Array<{norm:number, state:string, slope:number, rangeM:number}>}
 */
export function deriveTide(series) {
  const n = series.length;
  const levels = series.map((s) => s.seaLevel);
  const out = [];

  for (let i = 0; i < n; i++) {
    const lo0 = Math.max(0, i - HALF_WINDOW);
    const hi0 = Math.min(n - 1, i + HALF_WINDOW);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = lo0; j <= hi0; j++) {
      const v = levels[j];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const here = levels[i];
    const rangeM = hi - lo;
    // NaN, not 0.5, when there is nothing to go on. A default of mid tide is
    // indistinguishable from a real mid tide downstream, so a missing sea
    // level series silently cancelled every spot's tide preference instead of
    // announcing itself.
    const known = Number.isFinite(here) && rangeM > 0.05;
    const norm = known ? clamp((here - lo) / rangeM, 0, 1) : NaN;

    const prev = levels[Math.max(0, i - 1)];
    const next = levels[Math.min(n - 1, i + 1)];
    const slope = Number.isFinite(prev) && Number.isFinite(next)
      ? (next - prev) / 2
      : 0;

    let state;
    const nearFlat = Math.abs(slope) < rangeM * 0.06;
    if (!known) state = 'unknown';
    else if (nearFlat && norm > 0.7) state = 'high slack';
    else if (nearFlat && norm < 0.3) state = 'low slack';
    else if (slope > 0) state = 'rising';
    else if (slope < 0) state = 'falling';
    else state = 'slack';

    out.push({ norm, state, slope, rangeM });
  }
  return out;
}

/**
 * Turning points in the sea-level series — the actual high and low waters.
 * @returns {Array<{time: Date, kind: 'high'|'low', height: number}>}
 */
export function findExtremes(series) {
  const events = [];
  for (let i = 1; i < series.length - 1; i++) {
    const a = series[i - 1].seaLevel;
    const b = series[i].seaLevel;
    const c = series[i + 1].seaLevel;
    if (![a, b, c].every(Number.isFinite)) continue;
    if (b >= a && b > c) events.push({ time: series[i].time, kind: 'high', height: b });
    else if (b <= a && b < c) events.push({ time: series[i].time, kind: 'low', height: b });
  }
  // Drop near-duplicates from flat tops (two equal hours either side of slack).
  return events.filter((e, i) =>
    i === 0 || (e.time - events[i - 1].time) > 3 * 3600e3 || e.kind !== events[i - 1].kind);
}

/**
 * Springs / neaps, judged from the biggest daily range in the whole forecast.
 * The Tyne runs roughly 2.5 m on neaps and 4.5–5 m on springs.
 */
export function tideRegime(series) {
  const byDay = new Map();
  for (const s of series) {
    if (!Number.isFinite(s.seaLevel)) continue;
    const k = s.time.toDateString();
    const e = byDay.get(k) || { lo: Infinity, hi: -Infinity };
    e.lo = Math.min(e.lo, s.seaLevel);
    e.hi = Math.max(e.hi, s.seaLevel);
    byDay.set(k, e);
  }
  const ranges = new Map();
  for (const [k, e] of byDay) ranges.set(k, e.hi - e.lo);

  const all = [...ranges.values()].sort((a, b) => a - b);
  const maxSeen = all.length ? all[all.length - 1] : 0;

  return {
    rangeByDay: ranges,
    /** @returns {{rangeM:number, label:string, spring:boolean}} */
    forDate(date) {
      const rangeM = ranges.get(date.toDateString()) ?? NaN;
      if (!Number.isFinite(rangeM)) return { rangeM: NaN, label: 'unknown', spring: false };
      // Absolute thresholds first — they carry real meaning on this coast.
      let label = 'mid-range';
      if (rangeM >= 4.2) label = 'springs';
      else if (rangeM <= 2.8) label = 'neaps';
      else if (maxSeen > 0 && rangeM / maxSeen > 0.92) label = 'building';
      return { rangeM, label, spring: rangeM >= 4.2 };
    },
  };
}
