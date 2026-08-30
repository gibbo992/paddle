import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paddleOut, paddleOutEffort, surfZoneWidth, paddleOutEase } from '../js/paddleout.js';
import { annotateTrend, trendWord, trendArrow } from '../js/trend.js';
import {
  addSession, loadSessions, clearSessions, biasFor, tuningAdvice, ACTUAL_OPTIONS, MIN_SESSIONS,
} from '../js/sessionlog.js';
import { dataHealth } from '../js/api.js';
import { getCraft } from '../js/craft.js';
import { getSpot } from '../js/spots.js';

const surfKayak = getCraft('surf-kayak');
const wwKayak = getCraft('ww-kayak');
const board = getCraft('board');

// localStorage does not exist under node; the log module writes through it.
globalThis.localStorage = (() => {
  let store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => { store = new Map(); },
  };
})();

// --- getting out -----------------------------------------------------------

test('period decides the paddle out as much as height does', () => {
  // The whole reason this exists: 1.5 m at 12 s and 1.5 m at 6 s are the same
  // wave height and completely different paddle outs.
  const groundswell = paddleOut({ hs: 1.5, period: 12, craft: surfKayak });
  const windswell = paddleOut({ hs: 1.5, period: 6, craft: surfKayak });

  assert.ok(windswell.effort > groundswell.effort * 1.5,
    `short period should be far harder: ${groundswell.effort.toFixed(1)} vs ${windswell.effort.toFixed(1)}`);
  assert.ok(windswell.waves > groundswell.waves);
});

test('effort rises with size and the surf zone moves out with it', () => {
  const at = (hs) => paddleOutEffort({ hs, period: 10, craft: surfKayak });
  assert.ok(at(0.5) < at(1.0));
  assert.ok(at(1.0) < at(2.0));
  assert.ok(surfZoneWidth(2) > surfZoneWidth(1));
  assert.equal(surfZoneWidth(0), 0);
});

test('a duck dive is worth something, and a short slow boat is not', () => {
  const opts = { hs: 1.4, period: 10 };
  const sk = paddleOutEffort({ ...opts, craft: surfKayak });
  const ww = paddleOutEffort({ ...opts, craft: wwKayak });
  const bd = paddleOutEffort({ ...opts, craft: board });

  assert.ok(ww > sk, 'a river boat is slower and spends longer in the impact zone');
  assert.ok(bd < ww, 'a duck dive beats sitting in a short boat');
});

test('nothing breaking means nothing to paddle through', () => {
  assert.equal(paddleOutEffort({ hs: 0.1, period: 8, craft: surfKayak }), 0);
  assert.equal(paddleOut({ hs: 0, period: 8, craft: surfKayak }).label, 'Easy');
  assert.ok(Number.isFinite(paddleOutEffort({ hs: 1, period: NaN, craft: surfKayak })),
    'a missing period must not produce NaN');
});

test('every effort maps to a band and an ease fraction', () => {
  for (const hs of [0.3, 0.8, 1.2, 1.8, 2.5, 4]) {
    const out = paddleOut({ hs, period: 9, craft: surfKayak });
    assert.ok(out.label && out.tone && out.note);
    const ease = paddleOutEase(out.effort);
    assert.ok(ease >= 0 && ease <= 1);
  }
});

// --- trend -----------------------------------------------------------------

test('trend reads building, easing and holding', () => {
  const mk = (heights) => heights.map((waveHeight) => ({ waveHeight }));

  const building = annotateTrend(mk([0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.3]));
  assert.equal(building[0].trend, 'building');

  const easing = annotateTrend(mk([1.5, 1.4, 1.2, 1.1, 1.0, 0.9, 0.7, 0.6]));
  assert.equal(easing[0].trend, 'easing');

  const holding = annotateTrend(mk([1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.02, 1.0]));
  assert.equal(holding[0].trend, 'holding');
});

test('trend is relative, so small seas are not called building on noise', () => {
  // 15 cm of change: a big move on a 30 cm sea, nothing at all on 2 m.
  const small = annotateTrend(Array.from({ length: 8 }, (_, i) => ({ waveHeight: 0.2 + i * 0.03 })));
  const big = annotateTrend(Array.from({ length: 8 }, (_, i) => ({ waveHeight: 2.0 + i * 0.02 })));
  assert.equal(big[0].trend, 'holding', 'a fifth of a metre on 2 m is not a trend');
  assert.ok(['building', 'holding'].includes(small[0].trend));
});

test('missing heights give an unknown trend, not a wrong one', () => {
  const t = annotateTrend([{ waveHeight: NaN }, { waveHeight: NaN }]);
  assert.equal(t[0].trend, 'unknown');
  assert.equal(trendWord('unknown'), '');
  assert.equal(trendArrow('building'), '↑');
});

// --- session log -----------------------------------------------------------

test('logging a session records the gap between predicted and found', () => {
  clearSessions();
  addSession({ spotId: 'cullercoats', craftId: 'surf-kayak', predicted: 8.0, actual: 4.7 });
  addSession({ spotId: 'cullercoats', craftId: 'surf-kayak', predicted: 7.5, actual: 4.7 });

  const sessions = loadSessions();
  assert.equal(sessions.length, 2);

  const { count, bias } = biasFor('cullercoats', sessions);
  assert.equal(count, 2);
  assert.ok(bias < 0, 'negative bias means the app over-promised');
});

test('advice waits for enough sessions before claiming anything', () => {
  clearSessions();
  const spot = getSpot('cullercoats');
  addSession({ spotId: spot.id, craftId: 'surf-kayak', predicted: 8, actual: 4.7 });
  assert.match(tuningAdvice(spot).text, new RegExp(`1 of ${MIN_SESSIONS}`));

  addSession({ spotId: spot.id, craftId: 'surf-kayak', predicted: 8, actual: 4.7 });
  addSession({ spotId: spot.id, craftId: 'surf-kayak', predicted: 8, actual: 4.7 });

  const advice = tuningAdvice(spot);
  assert.match(advice.text, /too high/);
  assert.match(advice.text, /shelter/, 'must name the parameter to change');
});

test('advice says nothing when the app is reading about right', () => {
  clearSessions();
  const spot = getSpot('longsands');
  for (let i = 0; i < 4; i++) {
    addSession({ spotId: spot.id, craftId: 'surf-kayak', predicted: 7.7, actual: 7.7 });
  }
  assert.match(tuningAdvice(spot).text, /about right/);
});

test('one spot’s sessions do not tune another', () => {
  clearSessions();
  for (let i = 0; i < 4; i++) {
    addSession({ spotId: 'blyth', craftId: 'surf-kayak', predicted: 8, actual: 3 });
  }
  assert.equal(biasFor('whitley').count, 0);
  assert.equal(biasFor('blyth').count, 4);
});

test('a corrupt or empty store degrades to no sessions', () => {
  localStorage.setItem('ksc:sessions:v1', 'not json');
  assert.deepEqual(loadSessions(), []);
  localStorage.setItem('ksc:sessions:v1', '[{"spotId":"x"}]');
  assert.deepEqual(loadSessions(), [], 'entries without scores are dropped');
  clearSessions();
});

test('the rating options span the scale and carry scores', () => {
  assert.ok(ACTUAL_OPTIONS.length >= 5);
  assert.ok(ACTUAL_OPTIONS.every((o) => Number.isFinite(o.score) && o.label));
  const scores = ACTUAL_OPTIONS.map((o) => o.score);
  assert.ok(Math.max(...scores) > 8 && Math.min(...scores) < 2);
});

// --- data health -----------------------------------------------------------

test('data health reports what actually arrived', () => {
  const hours = Array.from({ length: 10 }, () => ({
    waveHeight: 1, swellPeriod: 8, swellDirection: 40,
    seaLevel: 0.5, seaTemp: 14, windKn: 9, windDirection: 250, airTemp: 15,
    modelCount: 4,
  }));
  const h = dataHealth(hours);
  assert.equal(h.missing.length, 0);
  assert.equal(h.models, 4);
  assert.ok(h.fields.every((f) => f.ok));
});

test('data health names the field that went missing', () => {
  // Exactly the shape of the bug that emptied the sea temperature and tide.
  const hours = Array.from({ length: 10 }, () => ({
    waveHeight: 1, swellPeriod: 8, swellDirection: 40,
    seaLevel: NaN, seaTemp: NaN, windKn: 9, windDirection: 250, airTemp: 15,
    modelCount: 3,
  }));
  const h = dataHealth(hours);
  assert.ok(h.missing.includes('Sea temperature'));
  assert.ok(h.missing.includes('Sea level (tide)'));
  assert.ok(!h.missing.includes('Wave height'), 'the waves were fine');
});
