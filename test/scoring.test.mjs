import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreHour, scoreWind, scoreSwellDirection, scoreTide, steepness, ratingFor } from '../js/scoring.js';
import { getSpot } from '../js/spots.js';
import { getCraft } from '../js/craft.js';
import { hour } from './fixtures.mjs';

const cullercoats = getSpot('cullercoats');
const longsands = getSpot('longsands');
const surfKayak = getCraft('surf-kayak');
const wwKayak = getCraft('ww-kayak');
const board = getCraft('board');

test('the premise: small weak surf scores better in a kayak than on a board', () => {
  // 0.55 m, 6 s — the classic "Surfline says 1/10" North Sea morning.
  const h = hour({ waveHeight: 0.55, swellHeight: 0.5, swellPeriod: 6, wavePeriod: 6 });
  const kayak = scoreHour(h, cullercoats, surfKayak).score;
  const shortboard = scoreHour(h, cullercoats, board).score;

  assert.ok(kayak > shortboard, `expected kayak ${kayak.toFixed(1)} > board ${shortboard.toFixed(1)}`);
  assert.ok(kayak >= 4.0, `small clean surf should still be worth a paddle, got ${kayak.toFixed(1)}`);
});

test('and big surf scores worse in a kayak than on a board', () => {
  const h = hour({ waveHeight: 2.6, swellHeight: 2.5, swellPeriod: 11, wavePeriod: 11 });
  const kayak = scoreHour(h, longsands, surfKayak);
  const shortboard = scoreHour(h, longsands, board);

  assert.ok(kayak.score < shortboard.score);
  assert.ok(kayak.flags.some((f) => f.code === 'too-big'), 'expected a too-big flag for the kayak');
});

test('a whitewater boat tops out lower than a surf kayak', () => {
  const h = hour({ waveHeight: 1.8, swellHeight: 1.7, swellPeriod: 9, wavePeriod: 9 });
  const ww = scoreHour(h, longsands, wwKayak);
  const sk = scoreHour(h, longsands, surfKayak);
  assert.ok(ww.score < sk.score);
  assert.ok(ww.flags.some((f) => f.code === 'too-big'));
});

test('a whitewater boat copes with short-period slop better than a board', () => {
  const h = hour({ waveHeight: 0.8, swellHeight: 0.75, swellPeriod: 4.5, wavePeriod: 4.5 });
  const ww = scoreHour(h, longsands, wwKayak).score;
  const bd = scoreHour(h, longsands, board).score;
  assert.ok(ww > bd, `ww ${ww.toFixed(1)} should beat board ${bd.toFixed(1)} in short-period windswell`);
});

test('flat is flat for everyone', () => {
  const h = hour({ waveHeight: 0.1, swellHeight: 0.1, swellPeriod: 4 });
  for (const craft of [surfKayak, wwKayak, board]) {
    const r = scoreHour(h, cullercoats, craft);
    assert.ok(r.score < 1.5, `${craft.id} scored ${r.score.toFixed(2)} on a flat sea`);
    assert.ok(r.flags.some((f) => f.code === 'flat'));
  }
});

test('a northerly swell gets into the open beach but not the tight bay', () => {
  // 350° is outside Cullercoats' NE–E window but still inside Longsands'.
  const h = hour({ swellDirection: 350, waveDirection: 350 });
  const cull = scoreHour(h, cullercoats, surfKayak).score;
  const longs = scoreHour(h, longsands, surfKayak).score;
  assert.ok(cull < 3, `Cullercoats on a N swell should be poor, got ${cull.toFixed(1)}`);
  assert.ok(longs > cull + 2, `Longsands (${longs.toFixed(1)}) should clearly beat Cullercoats (${cull.toFixed(1)})`);
});

test('a due-south swell is no good anywhere on this coast', () => {
  // Blocked by the headland everywhere — the model should not invent a session.
  for (const spot of [cullercoats, longsands]) {
    const r = scoreHour(hour({ swellDirection: 180, waveDirection: 180 }), spot, surfKayak);
    assert.ok(r.score < 3, `${spot.id} scored ${r.score.toFixed(1)} on a S swell`);
  }
});

test('direction attenuates height rather than just docking points', () => {
  const inWindow = scoreHour(hour({ swellDirection: 65 }), cullercoats, surfKayak);
  const offWindow = scoreHour(hour({ swellDirection: 350 }), cullercoats, surfKayak);
  assert.ok(offWindow.hs < inWindow.hs * 0.5, 'off-window swell should arrive much smaller');
  assert.ok(offWindow.exposure < inWindow.exposure);
});

test('geometric mean: one fatal component sinks the score', () => {
  // Perfect in every respect except direction.
  const good = scoreHour(hour({ swellDirection: 65 }), cullercoats, surfKayak).score;
  const wrongDir = scoreHour(hour({ swellDirection: 200 }), cullercoats, surfKayak).score;
  assert.ok(good > 6, `baseline should be good, got ${good.toFixed(1)}`);
  assert.ok(wrongDir < 3, `wrong direction should sink it, got ${wrongDir.toFixed(1)}`);
});

test('wind direction resolves against the beach normal', () => {
  // Cullercoats faces 070°, so offshore is 250°.
  const off = scoreWind(12, 250, cullercoats, surfKayak);
  const on = scoreWind(12, 70, cullercoats, surfKayak);
  assert.equal(off.relation, 'offshore');
  assert.equal(on.relation, 'onshore');
  assert.ok(off.score > on.score);
  assert.ok(off.onshoreKn < 0 && on.onshoreKn > 0);
});

test('strong offshore is penalised and flagged for a kayak', () => {
  const h = hour({ windKn: 26, windDirection: 250, windGustKn: 34 });
  const r = scoreHour(h, cullercoats, surfKayak);
  assert.ok(r.score <= 4.5, `strong offshore should cap the score, got ${r.score.toFixed(1)}`);
  assert.ok(r.flags.some((f) => f.code === 'strong-offshore'));
  assert.ok(r.flags.some((f) => f.code === 'gusts'));
});

test('kayaks tolerate onshore wind better than a board', () => {
  const h = hour({ windKn: 14, windDirection: 70 });
  const k = scoreWind(14, 70, cullercoats, surfKayak).score;
  const b = scoreWind(14, 70, cullercoats, board).score;
  assert.ok(k > b);
});

test('glassy beats everything regardless of direction', () => {
  assert.equal(scoreWind(2, 70, cullercoats, surfKayak).score, 1);
  assert.equal(scoreWind(2, 250, cullercoats, surfKayak).relation, 'glassy');
});

test('tide preference differs between spots', () => {
  // Cullercoats wants water on it; Longsands prefers it lower.
  assert.ok(scoreTide(0.8, cullercoats) > scoreTide(0.15, cullercoats));
  assert.ok(scoreTide(0.35, longsands) > scoreTide(1.0, longsands));
});

test('tide never zeroes a session outright', () => {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(scoreTide(t, cullercoats) >= 0.22);
  }
});

test('shelter factor makes the bay smaller than the open beach', () => {
  const h = hour({ waveHeight: 1.2 });
  const cull = scoreHour(h, cullercoats, surfKayak);
  const longs = scoreHour(h, longsands, surfKayak);
  assert.ok(cull.hs < longs.hs);
  assert.ok(Math.abs(cull.hs - 1.2 * cullercoats.shelter) < 1e-9);
});

test('steepness and face height are derived sanely', () => {
  assert.ok(Math.abs(steepness(1, 8) - 1 / (1.56 * 64)) < 1e-9);
  assert.ok(!Number.isFinite(steepness(1, 0)));
  const r = scoreHour(hour({ waveHeight: 1.0 }), longsands, surfKayak);
  assert.ok(r.faceM > r.hs, 'face height should exceed significant height');
  assert.ok(r.faceFt > 3 && r.faceFt < 6);
});

test('scores stay inside 0..10 across a wide sweep', () => {
  for (let hs = 0; hs <= 4; hs += 0.25) {
    for (let per = 3; per <= 18; per += 1.5) {
      for (const wd of [0, 70, 160, 250, 340]) {
        for (const wk of [0, 8, 18, 30]) {
          const r = scoreHour(
            hour({ waveHeight: hs, swellHeight: hs, swellPeriod: per, wavePeriod: per, windDirection: wd, windKn: wk }),
            cullercoats, surfKayak,
          );
          assert.ok(r.score >= 0 && r.score <= 10, `out of range: ${r.score}`);
          assert.ok(Number.isFinite(r.score), 'score must be finite');
        }
      }
    }
  }
});

test('missing data degrades rather than producing NaN', () => {
  const r = scoreHour(hour({ waveHeight: NaN, swellPeriod: NaN, windKn: NaN, tideNorm: NaN }), cullercoats, surfKayak);
  assert.ok(Number.isFinite(r.score));
});

test('rating bands are ordered and cover the range', () => {
  assert.equal(ratingFor(9).label, 'Excellent');
  assert.equal(ratingFor(7.2).label, 'Good');
  assert.equal(ratingFor(6).label, 'Fair');
  assert.equal(ratingFor(4.5).label, 'Marginal');
  assert.equal(ratingFor(3).label, 'Poor');
  assert.equal(ratingFor(0).label, 'Flat / no');
});

test('swell direction scoring is continuous around the window edge', () => {
  const w = cullercoats.swellWindow;
  const inside = scoreSwellDirection(w.from + 1, cullercoats);
  const outside = scoreSwellDirection(w.from - 1, cullercoats);
  assert.ok(Math.abs(inside - outside) < 0.15, 'no cliff at the window boundary');
});
