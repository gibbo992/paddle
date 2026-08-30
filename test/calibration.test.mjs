// Calibration against a published forecast.
//
// These are the anchors that stop the scale drifting. The app deliberately
// disagrees with a board-oriented forecast about whether a day is worth
// paddling — that is the whole point — but it must not disagree about how big
// the waves are, and it must not call a day "Excellent" that everyone else can
// see is small and weak.
//
// Source: Surfline, Tynemouth Longsands, 31/08/2026. Primary swell 1.8–2.2 ft
// at 7 s from 6–10°, wind 4–13 mph NW through W, rated poor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreHour, ratingFor, faceFactor } from '../js/scoring.js';
import { getSpot } from '../js/spots.js';
import { getCraft } from '../js/craft.js';

const FT = 0.3048;
const longsands = getSpot('longsands');
const surfKayak = getCraft('surf-kayak');
const board = getCraft('board');

/** One row of the published table. Swell heights are quoted in feet. */
function surflineHour({ swellFt, period, swellDir, windMph, windDir }) {
  const hs = swellFt * FT;
  return {
    time: new Date(2026, 7, 31, 12, 0),
    waveHeight: hs, swellHeight: hs,
    wavePeriod: period, swellPeriod: period,
    waveDirection: swellDir, swellDirection: swellDir,
    windKn: windMph * 0.868976, windGustKn: windMph * 1.7, windDirection: windDir,
    tideNorm: 0.5, tideState: 'rising',
    seaTemp: 15, airTemp: 16, apparentTemp: 14, precip: 0, daylight: true,
  };
}

const DAY = [
  { swellFt: 1.8, period: 7, swellDir: 9, windMph: 4, windDir: 315 },
  { swellFt: 1.8, period: 7, swellDir: 9, windMph: 7, windDir: 270 },
  { swellFt: 1.9, period: 7, swellDir: 10, windMph: 10, windDir: 292 },
  { swellFt: 2.1, period: 7, swellDir: 9, windMph: 11, windDir: 292 },
  { swellFt: 2.2, period: 7, swellDir: 6, windMph: 13, windDir: 270 },
  { swellFt: 2.2, period: 7, swellDir: 10, windMph: 13, windDir: 270 },
];

test('a 2 ft, 7 s day is never Excellent, in any craft', () => {
  for (const row of DAY) {
    for (const craft of ['surf-kayak', 'ww-kayak', 'board']) {
      const r = scoreHour(surflineHour(row), longsands, getCraft(craft));
      assert.ok(r.score < 7,
        `${craft} scored ${r.score.toFixed(1)} (${r.rating.label}) on ${row.swellFt} ft at ${row.period} s`);
    }
  }
});

test('a 2 ft, 7 s day is still worth a look in a boat, and not on a board', () => {
  const mid = surflineHour(DAY[4]);
  const kayak = scoreHour(mid, longsands, surfKayak);
  const shortboard = scoreHour(mid, longsands, board);

  // Rideable — this is the app's reason to exist.
  assert.ok(kayak.score >= 4, `expected at least marginal, got ${kayak.score.toFixed(1)}`);
  assert.ok(kayak.score > shortboard.score + 2, 'the board should write this off');
  assert.match(kayak.rating.label, /Marginal|Fair/);
});

test('face height lands in the published range', () => {
  // Surfline called it 1–2 ft of surf all day. Allow a little either side —
  // their surf height is a proprietary estimate — but not double.
  for (const row of DAY) {
    const r = scoreHour(surflineHour(row), longsands, surfKayak);
    assert.ok(r.faceFt >= 1.0 && r.faceFt <= 3.0,
      `${row.swellFt} ft at ${row.period} s gave a ${r.faceFt.toFixed(1)} ft face`);
  }
});

test('the score moves as the day does', () => {
  // The swell builds 1.8 → 2.2 ft across this day. A scale that reports the
  // same number for every hour is saturated, not stable.
  const scores = DAY.map((row) => scoreHour(surflineHour(row), longsands, surfKayak).score);
  assert.ok(Math.max(...scores) - Math.min(...scores) > 0.5,
    `expected the score to track the swell, got ${scores.map((s) => s.toFixed(1)).join(', ')}`);
});

test('face height scales with period, not just height', () => {
  // A 14 s groundswell stands up far more than a 7 s windswell of the same
  // height. A flat multiplier was reporting 3 ft faces on 1–2 ft days.
  assert.ok(faceFactor(14) > faceFactor(7));
  assert.ok(faceFactor(7) < 1.2, 'short-period windswell barely jacks up');
  assert.ok(faceFactor(NaN) > 0, 'missing period must not produce NaN');

  const short = scoreHour(surflineHour({ swellFt: 3, period: 6, swellDir: 45, windMph: 5, windDir: 248 }), longsands, surfKayak);
  const long = scoreHour(surflineHour({ swellFt: 3, period: 14, swellDir: 45, windMph: 5, windDir: 248 }), longsands, surfKayak);
  assert.ok(long.faceFt > short.faceFt, 'same swell height, longer period, bigger face');
});

test('the ideal band is what the craft wants, not merely what it can ride', () => {
  // Chest-high must beat knee-high by a wide margin in a surf kayak. When the
  // band started at 0.6 m these came out within a point of each other.
  const at = (hs, period) => scoreHour({
    ...surflineHour({ swellFt: 1, period, swellDir: 45, windMph: 5, windDir: 248 }),
    waveHeight: hs, swellHeight: hs,
  }, longsands, surfKayak).score;

  const knee = at(0.55, 7);
  const chest = at(1.2, 10);
  assert.ok(chest - knee > 3.5, `expected a wide gap, got knee ${knee.toFixed(1)} vs chest ${chest.toFixed(1)}`);
  assert.equal(ratingFor(chest).label, 'Excellent');
});
