// Small maths and formatting helpers. No DOM access in here so the scoring
// modules stay testable under plain node.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export function mean(xs) {
  const vals = xs.filter((x) => Number.isFinite(x));
  if (!vals.length) return NaN;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Ramp up from a→b, hold 1 across b→c, ramp down c→d. Outside a..d it is 0.
 * The workhorse for "there is an ideal band, and it tails off either side".
 */
export function trapezoid(x, a, b, c, d) {
  if (!Number.isFinite(x)) return 0;
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x <= c) return 1;
  return (d - x) / (d - c);
}

/**
 * A trapezoid with a gentle dome over its plateau, so the middle of an ideal
 * band beats its edges. A flat plateau makes a 0.7 m day and a 1.1 m day score
 * identically when one is plainly better than the other; `depth` is how much
 * the band edges give up (0.15 = 15%).
 */
export function bandScore(x, a, b, c, d, depth = 0.15) {
  const base = trapezoid(x, a, b, c, d);
  if (base <= 0) return 0;
  const half = (c - b) / 2;
  if (!(half > 0)) return base;
  // Measured from the plateau centre and clamped at the plateau edge, so the
  // dome is continuous with the ramps either side.
  const off = Math.min(1, Math.abs(x - (b + c) / 2) / half);
  return base * (1 - depth * off * off);
}

/** Smallest absolute separation between two compass bearings, 0..180. */
export function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Is bearing `x` inside the arc running clockwise from `from` to `to`? */
export function inArc(x, from, to) {
  const norm = (v) => ((v % 360) + 360) % 360;
  const span = norm(to - from);
  return norm(x - from) <= span;
}

/** Angular distance from `x` to the nearest edge of the arc from→to (0 if inside). */
export function arcDistance(x, from, to) {
  if (inArc(x, from, to)) return 0;
  return Math.min(angleDiff(x, from), angleDiff(x, to));
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass(deg) {
  if (!Number.isFinite(deg)) return '--';
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export const KN_PER_KMH = 0.539957;
export const M_PER_FT = 0.3048;

export const kmhToKn = (v) => v * KN_PER_KMH;
export const mToFt = (v) => v / M_PER_FT;

export function round(v, dp = 1) {
  if (!Number.isFinite(v)) return NaN;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Local ISO string Open-Meteo uses: 2026-08-29T06:00 */
export function isoLocal(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Parse Open-Meteo's timezone-less local timestamps as local wall-clock time. */
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return new Date(NaN);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
}

export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

/** "06:30" → 390 */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return NaN;
  return +m[1] * 60 + +m[2];
}

export function fmtHHMM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function fmtClock(date) {
  return fmtHHMM(minutesOfDay(date));
}

export function fmtDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
