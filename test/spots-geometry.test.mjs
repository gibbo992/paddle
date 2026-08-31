// Structural checks on the spot table.
//
// These exist because of a class of error that no amount of care in the
// scoring can catch: parameters that are individually plausible but cannot all
// be true at once. `facing` was derived from each guide's reported "best wind",
// a single coarse compass point, which put Seaton Sluice at 23° and Blyth at
// 113° — 90° apart for two beaches four kilometres apart on a coast that faces
// east throughout. A northerly then read as onshore at one and offshore at the
// other, which is backwards, and nothing in the tests noticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPOTS, getSpot } from '../js/spots.js';
import { scoreHour, scoreWind, blockingFor } from '../js/scoring.js';
import { getCraft } from '../js/craft.js';

const surfKayak = getCraft('surf-kayak');

const hour = (o = {}) => ({
  time: new Date(2026, 8, 1, 8, 0),
  waveHeight: 1.1, swellHeight: 1.1, wavePeriod: 9, swellPeriod: 9,
  waveDirection: 45, swellDirection: 45,
  windKn: 10, windGustKn: 15, windDirection: 225,
  tideNorm: 0.55, tideState: 'rising',
  seaTemp: 15, airTemp: 15, apparentTemp: 13, precip: 0, daylight: true,
  ...o,
});

test('every beach on this coast faces roughly east', () => {
  // Tynemouth to Blyth runs north–south; the beaches look out between NE and
  // ESE. Anything outside that is a data-entry error, not a real beach.
  for (const spot of SPOTS) {
    assert.ok(spot.facing >= 40 && spot.facing <= 110,
      `${spot.short} faces ${spot.facing}°, which is not possible on this coast`);
  }
});

test('neighbouring beaches do not face wildly different ways', () => {
  // Sorted north to south by latitude, the orientation should rotate gently.
  const byLat = [...SPOTS].sort((a, b) => b.lat - a.lat);
  for (let i = 1; i < byLat.length; i++) {
    const gap = Math.abs(byLat[i].facing - byLat[i - 1].facing);
    assert.ok(gap <= 35,
      `${byLat[i - 1].short} (${byLat[i - 1].facing}°) and ${byLat[i].short} `
      + `(${byLat[i].facing}°) are neighbours but face ${gap}° apart`);
  }
});

test('a northerly wind is not offshore at one beach and onshore at its neighbour', () => {
  const relations = SPOTS.map((s) => scoreWind(12, 0, s, surfKayak).relation);
  assert.ok(!relations.includes('offshore'),
    'a due north wind cannot be offshore on an east-facing coast');
});

test('on a northerly, Seaton Sluice beats Blyth', () => {
  // Blyth's harbour pier shadows it from the north — "can clean up a northerly
  // swell but does tend to cut the size". Seaton Sluice faces further NE and
  // has nothing in the way, so it is the call on a true northerly.
  const northerly = hour({ swellDirection: 355, waveDirection: 355, windDirection: 0 });
  const seaton = scoreHour(northerly, getSpot('seaton-sluice'), surfKayak);
  const blyth = scoreHour(northerly, getSpot('blyth'), surfKayak);

  assert.ok(seaton.score > blyth.score + 2,
    `Seaton ${seaton.score.toFixed(1)} should clearly beat Blyth ${blyth.score.toFixed(1)} on a northerly`);
  assert.ok(blyth.blocked, 'and the app should say why Blyth is small');
});

test('the pier only shadows Blyth from the north, not everywhere', () => {
  const blyth = getSpot('blyth');
  assert.ok(blockingFor(355, blyth).factor < 1, 'shadowed from due north');
  assert.ok(blockingFor(20, blyth).factor < 1, 'and from NNE');
  assert.equal(blockingFor(60, blyth).factor, 1, 'but not from the north-east');
  assert.equal(blockingFor(100, blyth).factor, 1, 'nor from the east');
  assert.equal(blockingFor(NaN, blyth).factor, 1);

  // On its own swell direction Blyth is a full-size open beach again.
  const ne = hour({ swellDirection: 50, waveDirection: 50 });
  const r = scoreHour(ne, blyth, surfKayak);
  assert.equal(r.blocked, null);
  assert.ok(r.score > 7, `Blyth should be good on a NE swell, got ${r.score.toFixed(1)}`);
});

test('no two spots are scoring identically across a sweep of directions', () => {
  // Three of them once shared the same swell window verbatim, so direction did
  // no discriminating at all between them.
  const signatures = new Map();
  for (const spot of SPOTS) {
    const sig = [340, 355, 10, 25, 45, 70, 95, 120]
      .map((d) => scoreHour(hour({ swellDirection: d, waveDirection: d }), spot, surfKayak).score.toFixed(1))
      .join(',');
    assert.ok(!signatures.has(sig),
      `${spot.short} and ${signatures.get(sig)} respond identically to every swell direction`);
    signatures.set(sig, spot.short);
  }
});

test('spots keep declaring where their numbers came from', () => {
  for (const spot of SPOTS) {
    assert.ok(['sourced', 'estimated'].includes(spot.confidence), `${spot.id} needs a confidence`);
    if (spot.blocking) {
      for (const b of spot.blocking) {
        assert.ok(b.why, 'a blocking arc must say what is in the way');
        assert.ok(b.factor > 0 && b.factor < 1, 'blocking reduces, it does not remove or amplify');
      }
    }
  }
});
