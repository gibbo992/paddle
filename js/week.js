// The week at a glance: every spot as a row, every day as a column.
//
// The hourly strip answers "when at this beach". It does not answer "which
// beach this week", which is the question you actually open the app with when
// the swell is marginal and every spot is different. This is that view, laid
// out to sit alongside the same grid in other forecast apps so the two can be
// compared line by line.

import { scoreHour, ratingFor } from './scoring.js';
import { mToFt, dayKey } from './util.js';

/** Parts of the day, matching how a session actually gets planned. */
export const BLOCKS = [
  { id: 'am', label: 'Morning', from: 5, to: 11 },
  { id: 'mid', label: 'Middle', from: 11, to: 16 },
  { id: 'pm', label: 'Evening', from: 16, to: 22 },
];

/** Value at a percentile of a sorted-able list. */
function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/**
 * Surfline-style size band. Their grid reads "0-1", "1-2", "Flat", so this
 * produces the same shape — the whole point is being able to hold the two
 * screens side by side.
 *
 * Takes a REPRESENTATIVE range, not the absolute extremes. Min-to-max across
 * fourteen daylight hours catches the one dead hour at dawn and the one peak
 * at dusk, and reports "1–4 ft" for a day that is 2 ft almost all of it.
 */
export function sizeBand(minM, maxM, units) {
  if (!Number.isFinite(maxM)) return '--';
  const toUnit = units?.height === 'm' ? (v) => v : mToFt;
  const hi = toUnit(maxM);
  const lo = toUnit(Math.max(0, minM));

  const flatUnder = units?.height === 'm' ? 0.25 : 0.8;
  if (hi < flatUnder) return 'Flat';

  const step = units?.height === 'm' ? 0.5 : 1;
  const l = Math.floor(lo / step) * step;
  const h = Math.max(l + step, Math.ceil(hi / step) * step);
  const fmt = (v) => (step < 1 ? v.toFixed(1) : String(v));
  return `${fmt(l)}–${fmt(h)}`;
}

/**
 * Build the grid.
 *
 * @param {Map<string,object>} forecasts spotId → forecast
 * @param {Array} spots
 * @param {object} craft
 * @returns {{days: Array, rows: Array}}
 */
export function weekGrid(forecasts, spots, craft, { now = new Date(), days = 6, units } = {}) {
  // Days come from whichever forecast we have — they all share a request shape.
  const any = [...forecasts.values()][0];
  if (!any) return { days: [], rows: [] };

  const today = dayKey(now);
  const dayKeys = [...any.daily.keys()].filter((k) => k >= today).slice(0, days);

  const dayCols = dayKeys.map((key) => {
    const date = any.daily.get(key).date;
    return {
      key,
      date,
      label: key === today ? 'Today' : date.toLocaleDateString('en-GB', { weekday: 'short' }),
      dayNum: date.getDate(),
      isToday: key === today,
    };
  });

  const rows = spots.map((spot) => {
    const fc = forecasts.get(spot.id);
    const cells = dayCols.map((col) => {
      if (!fc) return emptyCell();

      // Daylight only — a score at 3am is not a session.
      const meta = fc.daily.get(col.key);
      const hours = fc.hours.filter((h) => dayKey(h.time) === col.key
        && (!meta?.lightFrom || h.time >= meta.lightFrom)
        && (!meta?.lightTo || h.time <= meta.lightTo));

      if (!hours.length) return emptyCell();

      const scored = hours.map((h) => ({ h, res: scoreHour(h, spot, craft) }));
      const faces = scored.map((x) => x.res.faceM).filter(Number.isFinite);
      // Middle half of the day, so one flat dawn hour does not widen the band.
      const bandLo = percentile(faces, 0.25);
      const bandHi = percentile(faces, 0.75);

      const blocks = BLOCKS.map((b) => {
        const inBlock = scored.filter((x) => x.h.time.getHours() >= b.from && x.h.time.getHours() < b.to);
        if (!inBlock.length) return { id: b.id, score: NaN, tone: 'none' };
        // Best in the block: what matters is whether there is a window in it.
        const best = inBlock.reduce((a, x) => (x.res.score > a.res.score ? x : a));
        return { id: b.id, label: b.label, score: best.res.score, tone: ratingFor(best.res.score).tone };
      });

      const peak = scored.reduce((a, x) => (x.res.score > a.res.score ? x : a));

      return {
        size: sizeBand(bandLo, bandHi, units),
        blocks,
        best: peak.res.score,
        bestAt: peak.h.time,
        rating: peak.res.rating,
      };
    });

    return { spot, cells };
  });

  // Mark the best spot in each column, so the eye goes straight to it.
  dayCols.forEach((col, i) => {
    let bestScore = -1;
    let bestRow = -1;
    rows.forEach((row, r) => {
      const s = row.cells[i]?.best;
      if (Number.isFinite(s) && s > bestScore) { bestScore = s; bestRow = r; }
    });
    if (bestRow >= 0 && bestScore >= 4) rows[bestRow].cells[i].isPick = true;
  });

  return { days: dayCols, rows };
}

const emptyCell = () => ({ size: '--', blocks: BLOCKS.map((b) => ({ id: b.id, score: NaN, tone: 'none' })), best: NaN });
