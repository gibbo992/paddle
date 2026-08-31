// The scoring engine. Pure functions — no DOM, no network — so it can be
// tested directly and reasoned about.
//
// Five components, each 0..1, combined as a weighted geometric mean. Geometric
// rather than arithmetic on purpose: one fatal factor should sink the score.
// A 2 m swell with a perfect period arriving from the south-east is still
// nothing at Cullercoats, and an arithmetic mean would call that a 6/10.

import { clamp, trapezoid, bandScore, angleDiff, arcDistance, inArc, mToFt } from './util.js';

const FLOOR = 0.02;          // keeps ln() finite

// A perfect 10 should be a thing you remember, not a Tuesday. Everything ideal
// at once lands around 9.6, leaving the top of the scale genuinely rare.
const MAX_SCORE = 9.7;
/**
 * Hs → breaking face height.
 *
 * Not a constant: how much a wave stands up as it shoals depends on its
 * period. A 14 s groundswell feels the bottom far sooner and jacks up; a 7 s
 * windswell mostly just flops over. A flat 1.4× was reporting 3 ft faces on
 * days Surfline called 1–2 ft, which is most of what made the two disagree.
 */
export function faceFactor(period) {
  if (!Number.isFinite(period)) return 1.15;
  return clamp(0.75 + 0.05 * period, 0.95, 1.6);
}

/** Fallback for callers with no period to hand. */
export const FACE_FACTOR = 1.15;

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
  const crossScore = clamp(1 - Math.max(0, effCross - 6) / 28, 0.2, 1);

  return {
    score: clamp(onshoreScore * offshoreScore * crossScore, FLOOR, 1),
    relation, onshoreKn, crossKn, rel,
  };
}

/**
 * Anything shadowing this swell direction — a harbour pier, a headland.
 * @returns {{factor:number, why:string|null}}
 */
export function blockingFor(swellFromDeg, spot) {
  if (!Number.isFinite(swellFromDeg) || !spot.blocking?.length) return { factor: 1, why: null };
  for (const b of spot.blocking) {
    if (inArc(swellFromDeg, b.from, b.to)) return { factor: b.factor, why: b.why };
  }
  return { factor: 1, why: null };
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
    return clamp(0.4 + 0.6 * t, 0.4, 1);
  }
  // Outside the window entirely: falls away fast.
  const miss = arcDistance(swellFromDeg, w.from, w.to);
  return clamp(0.4 * Math.exp(-miss / 22), FLOOR, 0.4);
}

export function scoreTide(tideNorm, spot, tideState) {
  if (!Number.isFinite(tideNorm)) return 0.7;
  const t = spot.tide;
  // Floored — the wrong tide usually makes a break worse, not absent.
  let score = clamp(trapezoid(tideNorm, t.ok0 - 0.12, t.best0, t.best1, t.ok1 + 0.12), 0.22, 1);

  // Some breaks want the tide moving, not just at a height. The Longsands
  // banks are described as working "on the tidal push" and Blyth as better on
  // a rising tide. Height alone can't express that, so it's a modest separate
  // term — a secondary effect, not a deciding one.
  if (spot.prefersPush && tideState) {
    if (tideState === 'rising') score = clamp(score * 1.08, 0, 1);
    else if (tideState === 'falling') score = clamp(score * 0.92, 0, 1);
  }
  return score;
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

  // A pier or headland that shadows one arc of swell. `shelter` is a constant,
  // so it cannot say "this beach is open except from the north" — which is
  // exactly Blyth, where the harbour pier tidies a northerly up but cuts it
  // down. Blocking applies to height, because that is what it takes away.
  const block = blockingFor(swellDir, spot);

  // How much of the open-coast swell actually reaches the sand. Three effects,
  // all real and all multiplying the height: the headlands that shelter the
  // beach at all times, anything shadowing this particular swell direction,
  // and how square the swell is to the window. A swell from outside the window
  // does not arrive small — it does not arrive. Attenuating height (rather
  // than just docking points) is what makes an out-of-window day read as flat
  // instead of mediocre.
  const exposure = spot.shelter * block.factor * clamp(dirScore, 0.02, 1) ** 0.6;
  const hs = Number.isFinite(h.waveHeight) ? h.waveHeight * exposure : NaN;

  const sizeScore = bandScore(hs, craft.size.a, craft.size.b, craft.size.c, craft.size.d, 0.30);

  const periodScore = bandScore(period, craft.period.a, craft.period.b, craft.period.c, craft.period.d, 0.10);
  const steep = steepness(hs, period);
  const steepScore = trapezoid(steep, craft.steepness.a, craft.steepness.b, craft.steepness.c, craft.steepness.d);
  // Period leads and steepness trims: the two overlap, and period is the more
  // reliable signal. Steepness is here to separate punchy from gutless at the
  // same period, not to halve the score on its own.
  const powerScore = Math.max(periodScore, FLOOR) ** 0.65 * Math.max(steepScore, FLOOR) ** 0.35;

  const wind = scoreWind(h.windKn, h.windDirection, spot, craft);
  const tideScore = scoreTide(h.tideNorm, spot, h.tideState);

  const parts = {
    size: sizeScore,
    power: powerScore,
    wind: wind.score,
    direction: dirScore,
    tide: tideScore,
  };

  // Two stages, because these five are not the same kind of thing.
  //
  // Size and power ARE the wave — they set the ceiling on how good the session
  // can possibly be. Wind, direction and tide are permissive: they decide how
  // much of that wave survives to the beach. A flat calm morning at perfect
  // tide with a textbook offshore breeze is still a flat calm morning, and a
  // flat average over all five would score it a 7 because nothing is "wrong".
  const weights = {
    size: 1.7,
    power: 1.0,
    wind: 1.5,
    direction: spot.dirWeight * 0.35,  // most of direction is already in the height
    tide: spot.tideWeight,
  };

  const geo = (keys) => {
    let wsum = 0;
    let lsum = 0;
    for (const k of keys) {
      wsum += weights[k];
      lsum += weights[k] * Math.log(Math.max(parts[k], FLOOR));
    }
    return Math.exp(lsum / wsum);
  };

  const wave = geo(['size', 'power']);          // what the swell is offering
  const conditions = geo(['wind', 'direction', 'tide']); // how much of it survives

  // Conditions can only take away. The exponent stops a single average factor
  // from flattening an otherwise excellent swell.
  let score = wave * conditions ** 0.85 * MAX_SCORE;

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
    wave,
    conditions,
    flags,
    wind,
    hs,
    exposure,
    blocked: block.why,
    openCoastHs: Number.isFinite(h.waveHeight) ? h.waveHeight : NaN,
    faceFactor: faceFactor(period),
    faceM: Number.isFinite(hs) ? hs * faceFactor(period) : NaN,
    faceFt: Number.isFinite(hs) ? mToFt(hs * faceFactor(period)) : NaN,
    period,
    swellDir,
    steepness: steep,
  };
}

/**
 * The weakest component, and a phrase for it.
 *
 * The phrasing has to track the DEGREE, not just the identity: a direction
 * score of 0.7 means the swell is a little off-axis, not that it is out of the
 * window, and saying the latter under an 8.9 reads as a contradiction. Size
 * also has to know which way it is wrong — the same low score means "too
 * small" below the band and "too big" above it.
 */
export function limitingFactor(res, craft) {
  let [key, val] = Object.entries(res.parts).sort((a, b) => a[1] - b[1])[0];

  // Direction attenuates height, so a swell from the wrong quarter shows up as
  // a size problem. Report the cause, not the symptom: "too small" is true but
  // useless when the answer is that the swell is pointing somewhere else.
  if (key === 'size' && res.parts.direction < 0.35) {
    key = 'direction';
    val = res.parts.direction;
  }

  const bad = val < 0.4;
  let label;

  switch (key) {
    case 'size': {
      const mid = craft ? (craft.size.b + craft.size.c) / 2 : NaN;
      const big = Number.isFinite(mid) && res.hs > mid;
      if (big) label = bad ? 'too big' : 'on the big side';
      else label = bad ? 'too small' : 'on the small side';
      break;
    }
    case 'power':
      label = bad ? 'gutless and shapeless' : 'a bit soft';
      break;
    case 'wind':
      label = `the wind is ${res.wind.relation}`;
      break;
    case 'direction':
      label = bad ? 'the swell is out of the window' : 'the swell angle is off-square';
      break;
    case 'tide':
      label = bad ? 'the tide is wrong for it' : 'the tide is not quite right';
      break;
    default:
      label = key;
  }
  return { key, val, label };
}

/**
 * One-line verdict, written the way you'd say it in the car park.
 * `future` matters: "go now" is nonsense about Thursday dawn.
 */
export function verdictFor(res, spot, craft, { future = false } = {}) {
  if (res.flags.some((f) => f.code === 'flat')) return `Flat at ${spot.short}. Nothing doing.`;
  if (res.flags.some((f) => f.code === 'too-big')) return craft.tooBigMsg;

  const { label } = limitingFactor(res, craft);

  if (res.score >= 8.5) {
    return future
      ? `About as good as ${spot.short} gets. Book it off.`
      : `As good as it gets at ${spot.short} — go now.`;
  }
  if (res.score >= 7) return future ? 'Properly worth the drive.' : 'Properly worth it — get down there.';
  if (res.score >= 5.5) return `Rideable and worth a go — ${label}, but nothing fatal.`;
  if (res.score >= 4) return `Marginal. Only if you're keen — ${label}.`;
  return `Not worth it — ${label}.`;
}
