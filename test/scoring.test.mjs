import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreHour, scoreWind, scoreSwellDirection, scoreTide, steepness, ratingFor, limitingFactor } from '../js/scoring.js';
import { getSpot, SPOTS } from '../js/spots.js';
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

test('the score spreads across the range instead of bunching at the top', () => {
  // Sampled across conditions that actually occur, not a curated list of good
  // days: most hours on this coast are not surfable, and the scale has to say
  // so. "Nothing is wrong" must not be enough to score well on its own.
  const scores = [];
  for (const hs of [0.1, 0.3, 0.6, 0.9, 1.3, 1.8, 2.4, 3.0]) {
    for (const per of [4, 6, 8, 11, 14]) {
      for (const windDir of [70, 160, 250, 340]) {
        for (const windKn of [3, 10, 18, 26]) {
          for (const tideNorm of [0.1, 0.5, 0.9]) {
            scores.push(scoreHour(hour({
              waveHeight: hs, swellHeight: hs, swellPeriod: per, wavePeriod: per,
              windDirection: windDir, windKn, tideNorm,
            }), longsands, surfKayak).score);
          }
        }
      }
    }
  }

  const frac = (p) => scores.filter(p).length / scores.length;
  const excellent = frac((s) => s >= 8.5);
  const poor = frac((s) => s < 4);

  assert.ok(excellent < 0.10, `too many excellent scores: ${(excellent * 100).toFixed(1)}%`);
  assert.ok(poor > 0.35, `not enough poor scores — the scale is too generous: ${(poor * 100).toFixed(1)}%`);
  assert.ok(Math.max(...scores) <= 9.7, 'nothing should exceed the ceiling');
  assert.ok(Math.max(...scores) - Math.min(...scores) > 8, 'scores should span most of the scale');
});

test('bigger and cleaner beats smaller and weaker, up to the craft ceiling', () => {
  const at = (hs, per) => scoreHour(hour({
    waveHeight: hs, swellHeight: hs, swellPeriod: per, wavePeriod: per,
  }), longsands, surfKayak).score;

  assert.ok(at(0.15, 5) < at(0.4, 6));
  assert.ok(at(0.4, 6) < at(0.7, 8));
  assert.ok(at(0.7, 8) < at(1.1, 10));
  assert.ok(at(1.1, 10) > at(2.5, 13), 'past the ceiling it should fall away again');
});

test('the middle of an ideal band beats its edges', () => {
  // A flat plateau would score these identically; they are not the same day.
  const at = (hs) => scoreHour(hour({ waveHeight: hs, swellHeight: hs, swellPeriod: 10, wavePeriod: 10 }),
    longsands, surfKayak).score;
  assert.ok(at(1.1) > at(0.7), 'chest high should beat knee high in a surf kayak');
  assert.ok(at(1.1) > at(1.6), 'and beat the top of the band too');
});

test('permissive factors cannot manufacture a session out of no swell', () => {
  // Perfect wind, perfect tide, swell dead in the window — but nothing to ride.
  const r = scoreHour(hour({
    waveHeight: 0.2, swellHeight: 0.2, swellPeriod: 5, wavePeriod: 5,
    windKn: 2, tideNorm: 0.7,
  }), cullercoats, surfKayak);
  assert.ok(r.score < 2, `expected near-zero, got ${r.score.toFixed(1)}`);
});

test('wave and conditions stages are reported separately', () => {
  const r = scoreHour(hour(), cullercoats, surfKayak);
  assert.ok(r.wave > 0 && r.wave <= 1);
  assert.ok(r.conditions > 0 && r.conditions <= 1);
});

test('a rising tide is preferred only where the guides say so', () => {
  // Longsands banks work "on the tidal push"; King Edward's has no such note.
  const push = (spot, tideState) => scoreTide(0.5, spot, tideState);
  assert.ok(push(longsands, 'rising') > push(longsands, 'falling'));
  assert.equal(push(getSpot('kingedwards'), 'rising'), push(getSpot('kingedwards'), 'falling'));
});

test('tide preferences match the researched spot data', () => {
  // King Edward's is a low-tide break; Blyth is a high-tide one. If these ever
  // flip, the spot table has drifted from its sources.
  const keb = getSpot('kingedwards');
  const blyth = getSpot('blyth');
  assert.ok(scoreTide(0.15, keb) > scoreTide(0.9, keb), "King Edward's should favour low water");
  assert.ok(scoreTide(0.9, blyth) > scoreTide(0.15, blyth), 'Blyth should favour high water');
  // Longsands works at all stages — no state of tide should be badly punished.
  const ls = [0.1, 0.35, 0.6, 0.85].map((t) => scoreTide(t, longsands));
  assert.ok(Math.min(...ls) > 0.7, `Longsands should work through the tide: ${ls.join(', ')}`);
});

test('spot hazards are surfaced, not buried in prose', () => {
  for (const spot of SPOTS) {
    assert.ok(Array.isArray(spot.hazards), `${spot.id} needs a hazards array`);
    assert.ok(['sourced', 'estimated'].includes(spot.confidence),
      `${spot.id} must declare whether its parameters are sourced or estimated`);
  }
  assert.ok(getSpot('whitley').hazards.some((h) => /rock/i.test(h)), 'Whitley: rocks are a stated hazard');
});

test('the limiting factor knows which way size is wrong', () => {
  const big = scoreHour(hour({ waveHeight: 2.3, swellHeight: 2.3, swellPeriod: 11, wavePeriod: 11 }),
    longsands, surfKayak);
  const small = scoreHour(hour({ waveHeight: 0.3, swellHeight: 0.3, swellPeriod: 7, wavePeriod: 7 }),
    longsands, surfKayak);

  assert.match(limitingFactor(big, surfKayak).label, /big/, 'an oversized day must not read as "too small"');
  assert.match(limitingFactor(small, surfKayak).label, /small/);
});

test('limiting-factor wording matches how bad it actually is', () => {
  // A mildly off-axis swell must not be described as out of the window — that
  // reads as a contradiction next to a high score.
  const slightlyOff = scoreHour(hour({ swellDirection: 100, waveDirection: 100 }), longsands, surfKayak);
  const wayOff = scoreHour(hour({ swellDirection: 200, waveDirection: 200 }), longsands, surfKayak);

  const mild = limitingFactor(slightlyOff, surfKayak);
  if (mild.key === 'direction' && mild.val >= 0.4) {
    assert.doesNotMatch(mild.label, /out of the window/);
  }
  // A swell from the wrong quarter arrives as no swell at all, so size scores
  // zero — but the useful thing to say is why, not that it is small.
  const severe = limitingFactor(wayOff, surfKayak);
  assert.equal(severe.key, 'direction', 'should blame the cause, not the symptom');
  assert.match(severe.label, /out of the window/);
});

test('Hartley Reef is configured as a reef and takes a wide swell window', () => {
  const hartley = getSpot('hartley-reef');
  assert.equal(hartley.reef, true);
  // It focuses swell rather than sheltering from it — that is why it works
  // when the beaches are still flat.
  assert.ok(hartley.shelter > 1, 'a reef should concentrate swell, not reduce it');
  assert.ok(scoreTide(0.8, hartley) > scoreTide(0.2, hartley), 'mid-to-high break');
  assert.ok(hartley.prefersPush, 'works on the push');

  // Takes N through E, so it holds up further round than the beaches.
  assert.ok(scoreSwellDirection(95, hartley) > scoreSwellDirection(95, getSpot('kingedwards')));
});

test('a reef works on a swell that leaves the beaches flat', () => {
  // Half a metre: under the beaches' threshold, but the reef focuses it.
  const small = hour({ waveHeight: 0.5, swellHeight: 0.5, swellPeriod: 9, wavePeriod: 9, tideNorm: 0.75 });
  const reef = scoreHour(small, getSpot('hartley-reef'), surfKayak);
  const beach = scoreHour(small, getSpot('whitley'), surfKayak);
  assert.ok(reef.hs > beach.hs, 'the reef should see more of the swell than the beach');
  assert.ok(reef.score > beach.score);
});
