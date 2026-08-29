// The scoring engine. Pure functions — no DOM, no network — so it can be
// tested directly and reasoned about.
//
// Five components, each 0..1, combined as a weighted geometric mean. Geometric
// rather than arithmetic on purpose: one fatal factor should sink the score.
// A 2 m swell with a perfect period arriving from the south-east is still
// nothing at Cullercoats, and an arithmetic mean would call that a 6/10.

import { clamp, trapezoid, angleDiff, arcDistance, inArc, mToFt, kmhToKn } from './util.js';

const FLOOR = 0.02;          // keeps ln() finite
export const FACE_FACTOR = 1.4; // Hs → breaking face height, roughly

export const RATINGS = [
  { min: 8.5, label: 'Excellent', tone: 'excellent' },
  { min: 7.0, label: 'Good', tone: 'good' },
  { min: 5.5, label: 'Fair', tone: 'fair' },
  { min: 4.0, label: 'Marginal', tone: 'marginal' },
  { min: 2.0, label: 'Poor', tone: 'poor' },
  { min: -1, label: 'Flat / no', tone: 'none' },
];

export function ratingFor(score) {
  return RATINGS.find((r) => score >= r.min) || RATINGS[RATINGS.length - 1];
}

/** Deep-water wave steepness, Hs / L where L = 1.56·T². */
export function steepness(hs, period) {
  if (!(period > 0) || !Number.isFinite(hs)) return NaN;
  return hs / (1.56 * period * period);
}

/**
 * Wind, resolved against the beach's seaward normal.
 * Returns component knots plus a 0..1 score for this craft.
 */
export function scoreWind(windKn, windFromDeg, spot, craft) {
  if (!Number.isFinite(windKn)) return { score: 0.5, relation: 'unknown', onshoreKn: NaN, crossKn: NaN };

  // Offshore wind blows from the land: from the bearing opposite the beach normal.
  const offshoreBearing = (spot.facing + 180) % 360;
  const rel = angleDiff(windFromDeg, offshoreBearing); // 0 = dead offshore, 180 = dead onshore
  const relRad = (rel * Math.PI) / 180;

  const onshoreKn = -Math.cos(relRad) * windKn; // >0 onshore, <0 offshore
  const crossKn = Math.abs(Math.sin(relRad)) * windKn;

  let relation;
  if (windKn < 4) relation = 'glassy';
  else if (rel <= 45) relation = 'offshore';
  else if (rel <= 75) relation = 'cross-offshore';
  else if (rel < 105) relation = 'cross-shore';
  else if (rel < 135) relation = 'cross-onshore';
  else relation = 'onshore';

  if (windKn < 4) return { score: 1, relation, onshoreKn, crossKn, rel };

  // Onshore: destroys shape. Kayaks tolerate more of it than a board does.
  let onshoreScore = 1;
  if (onshoreKn > 0) {
    const eff = onshoreKn / craft.onshoreTolerance;
    onshoreScore = clamp(1 - Math.max(0, eff - 3) / 19, 0.03, 1);
  }

  // Offshore: good, until it is enough to hold you off the back of the wave and
  // blow a high-sided boat out to sea.
  let offshoreScore = 1;
  if (onshoreKn < 0) {
    const eff = (-onshoreKn) / craft.offshoreTolerance;
    offshoreScore = clamp(1 - Math.max(0, eff - 14) / 24, 0.15, 1);
  }

  // Cross wind: chop plus weathercocking, which a long boat feels badly.
  const effCross = crossKn / craft.crossTolerance;
  const crossScore = clamp(1 - Math.max(0, effCross - 10) / 30, 0.2, 1);

  return {
    score: clamp(onshoreScore * offshoreScore * crossScore, FLOOR, 1),
    relation, onshoreKn, crossKn, rel,
  };
}

/** How well the swell direction lines up with this spot's window. */
export function scoreSwellDirection(swellFromDeg, spot) {
  if (!Number.isFinite(swellFromDeg)) return 0.5;
  const w = spot.swellWindow;
  if (inArc(swellFromDeg, w.best0, w.best1)) return 1;
  if (inArc(swellFromDeg, w.from, w.to)) {
    // Inside the window but off the core — taper toward the window edges.
    const dCore = Math.min(angleDiff(swellFromDeg, w.best0), angleDiff(swellFromDeg, w.best1));
    const dEdge = Math.min(angleDiff(swellFromDeg, w.from), angleDiff(swellFromDeg, w.to));
    const t = dEdge / Math.max(1, dCore + dEdge);
    return clamp(0.25 + 0.75 * t, 0.25, 1);
  }
  // Outside the window entirely: falls away fast.
  const miss = arcDistance(swellFromDeg, w.from, w.to);
  return clamp(0.25 * Math.exp(-miss / 18), FLOOR, 0.25);
}

export function scoreTide(tideNorm, spot) {
  if (!Number.isFinite(tideNorm)) return 0.7;
  const t = spot.tide;
  // Floored — the wrong tide usually makes a break worse, not absent.
  return clamp(trapezoid(tideNorm, t.ok0 - 0.12, t.best0, t.best1, t.ok1 + 0.12), 0.22, 1);
}

/**
 * Score one hour at one spot for one craft.
 *
 * @param {object} h  hourly record from api.js
 * @param {object} spot
 * @param {object} craft
 */
export function scoreHour(h, spot, craft) {
  const period = Number.isFinite(h.swellPeriod) ? h.swellPeriod : h.wavePeriod;
  const swellDir = Number.isFinite(h.swellDirection) ? h.swellDirection : h.waveDirection;

  const dirScore = scoreSwellDirection(swellDir, spot);

  // How much of the open-coast swell actually reaches the sand. Two effects,
  // both real and both multiplying the height: the headlands and piers that
  // shelter the bay at all times, and how square the swell is to the window.
  // A swell from outside the window does not arrive small — it does not arrive.
  // Attenuating height (rather than just docking points) is what makes an
  // out-of-window day read as flat instead of mediocre.
  const exposure = spot.shelter * clamp(dirScore, 0.02, 1) ** 0.6;
  const hs = Number.isFinite(h.waveHeight) ? h.waveHeight * exposure : NaN;

  const sizeScore = trapezoid(hs, craft.size.a, craft.size.b, craft.size.c, craft.size.d);

  const periodScore = trapezoid(period, craft.period.a, craft.period.b, craft.period.c, craft.period.d);
  const steep = steepness(hs, period);
  const steepScore = trapezoid(steep, craft.steepness.a, craft.steepness.b, craft.steepness.c, craft.steepness.d);
  // Geometric mean: a wave needs both enough energy and enough shape.
  const powerScore = Math.sqrt(Math.max(periodScore, FLOOR) * Math.max(steepScore, FLOOR));

  const wind = scoreWind(h.windKn, h.windDirection, spot, craft);
  const tideScore = scoreTide(h.tideNorm, spot);

  const parts = {
    size: sizeScore,
    power: powerScore,
    wind: wind.score,
    direction: dirScore,
    tide: tideScore,
  };

  const weights = {
    size: 1.7,
    power: 1.0,
    wind: 1.5,
    direction: spot.dirWeight,
    tide: spot.tideWeight,
  };

  let wsum = 0;
  let lsum = 0;
  for (const k of Object.keys(parts)) {
    const w = weights[k];
    wsum += w;
    lsum += w * Math.log(Math.max(parts[k], FLOOR));
  }
  let score = Math.exp(lsum / wsum) * 10;

  const flags = [];

  // Hard caps — these are judgements the weighted mean must not be able to talk
  // its way out of.
  if (Number.isFinite(hs) && hs > craft.hardMax) {
    score = Math.min(score, 2.2);
    flags.push({ level: 'critical', text: craft.tooBigMsg, code: 'too-big' });
  }
  if (Number.isFinite(hs) && hs < craft.size.a) {
    score = Math.min(score, 0.8);
    flags.push({ level: 'info', text: craft.tooSmallMsg, code: 'flat' });
  }
  if (wind.relation === 'offshore' && -wind.onshoreKn >= 22) {
    score = Math.min(score, 4.5);
    flags.push({
      level: 'critical',
      code: 'strong-offshore',
      text: `Strong offshore (${Math.round(-wind.onshoreKn)} kn) — a kayak gets blown offshore fast. Don't go out alone.`,
    });
  }
  if (Number.isFinite(h.windGustKn) && h.windGustKn >= 32) {
    flags.push({ level: 'warning', code: 'gusts', text: `Gusting ${Math.round(h.windGustKn)} kn.` });
  }

  score = clamp(score, 0, 10);

  return {
    score,
    rating: ratingFor(score),
    parts,
    weights,
    flags,
    wind,
    hs,
    exposure,
    openCoastHs: Number.isFinite(h.waveHeight) ? h.waveHeight : NaN,
    faceM: Number.isFinite(hs) ? hs * FACE_FACTOR : NaN,
    faceFt: Number.isFinite(hs) ? mToFt(hs * FACE_FACTOR) : NaN,
    period,
    swellDir,
    steepness: steep,
  };
}

/** One-line verdict, written the way you'd say it to someone in the car park. */
export function verdictFor(res, spot, craft) {
  const p = res.parts;
  if (res.flags.some((f) => f.code === 'flat')) return `Flat at ${spot.short}. Nothing doing.`;
  if (res.flags.some((f) => f.code === 'too-big')) return craft.tooBigMsg;

  const weakest = Object.entries(p).sort((a, b) => a[1] - b[1])[0];
  const label = {
    size: 'too small',
    power: 'gutless and shapeless',
    wind: `wind is ${res.wind.relation}`,
    direction: 'swell is out of the window',
    tide: 'wrong tide',
  }[weakest[0]];

  if (res.score >= 8.5) return `As good as it gets at ${spot.short} — go now.`;
  if (res.score >= 7) return `Properly worth the drive.`;
  if (res.score >= 5.5) return `Rideable and worth a go — ${label}, but nothing fatal.`;
  if (res.score >= 4) return `Marginal. Only if you're keen — ${label}.`;
  return `Not worth it — ${label}.`;
}
