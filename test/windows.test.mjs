import { test } from 'node:test';
import assert from 'node:assert/strict';

import { subtract, intersect, candidateSlots, applyBusy, findBestWindows } from '../js/windows.js';
import { mergeBusy } from '../js/calendar.js';
import { getSpot } from '../js/spots.js';
import { getCraft } from '../js/craft.js';
import { DEFAULT_SETTINGS } from '../js/store.js';
import { makeForecast } from './fixtures.mjs';

const d = (h, m = 0) => new Date(2026, 8, 1, h, m);
const settings = { ...DEFAULT_SETTINGS, minWindowScore: 0 };

test('subtract removes a busy block from the middle', () => {
  const out = subtract({ start: d(6), end: d(12) }, [{ start: d(8), end: d(9) }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => [p.start.getHours(), p.end.getHours()]), [[6, 8], [9, 12]]);
});

test('subtract handles overlapping ends and full cover', () => {
  assert.deepEqual(
    subtract({ start: d(6), end: d(12) }, [{ start: d(5), end: d(7) }]).map((p) => p.start.getHours()),
    [7],
  );
  assert.equal(subtract({ start: d(6), end: d(12) }, [{ start: d(5), end: d(13) }]).length, 0);
});

test('intersect returns null when there is no overlap', () => {
  assert.equal(intersect({ start: d(6), end: d(7) }, { start: d(8), end: d(9) }), null);
  assert.ok(intersect({ start: d(6), end: d(9) }, { start: d(8), end: d(10) }));
});

test('mergeBusy collapses overlapping calendar blocks', () => {
  const merged = mergeBusy([
    { start: d(9), end: d(10) },
    { start: d(9, 30), end: d(11) },
    { start: d(14), end: d(15) },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end.getHours(), 11);
});

test('candidate slots respect weekday rules and daylight', () => {
  // 2026-09-01 is a Tuesday, so weekday rules apply and the weekend rule does not.
  const fc = makeForecast('cullercoats', { days: 2 });
  const slots = candidateSlots(fc, settings, { now: new Date(2026, 8, 1, 0, 0) });
  const ids = new Set(slots.map((s) => s.ruleId));
  assert.ok(ids.has('dawn'));
  assert.ok(ids.has('evening'));
  assert.ok(!ids.has('weekend'), 'no weekend rule on a Tuesday');

  // Sunrise in the fixture is 05:40, so the 05:30 dawn rule is clipped to first light.
  const dawn = slots.find((s) => s.ruleId === 'dawn');
  assert.ok(dawn.start.getHours() * 60 + dawn.start.getMinutes() >= 5 * 60 + 15);
});

test('slots in the past are dropped', () => {
  const fc = makeForecast('cullercoats', { days: 2 });
  const slots = candidateSlots(fc, settings, { now: new Date(2026, 8, 1, 12, 0) });
  assert.ok(slots.every((s) => s.end > new Date(2026, 8, 1, 12, 0)));
  assert.ok(!slots.some((s) => s.ruleId === 'dawn' && s.dayKey === '2026-09-01'));
});

test('a calendar block carves the session window up, with travel padding', () => {
  const slot = { start: d(17), end: d(21), pieces: null };
  const [out] = applyBusy([slot], [{ start: d(18), end: d(19) }], 15);
  assert.equal(out.pieces.length, 2);
  // The 18:00 meeting blocks from 17:45 (travel there) to 19:15 (travel back).
  assert.equal(out.pieces[0].end.getHours() * 60 + out.pieces[0].end.getMinutes(), 17 * 60 + 45);
  assert.equal(out.pieces[1].start.getHours() * 60 + out.pieces[1].start.getMinutes(), 19 * 60 + 15);
});

test('best windows are found, ranked and one-per-session-slot', () => {
  const fc = makeForecast('cullercoats', { days: 3 });
  const forecasts = new Map([['cullercoats', fc]]);
  const out = findBestWindows(forecasts, [getSpot('cullercoats')], getCraft('surf-kayak'), settings, {
    now: new Date(2026, 8, 1, 0, 0),
  });

  assert.ok(out.length > 0, 'expected some windows');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].mean >= out[i].mean, 'ranked by score');
  const keys = out.map((w) => `${w.dayKey}:${w.ruleId}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate session slots');
  for (const w of out) {
    assert.ok(w.durationMins >= settings.minSessionMins);
    assert.ok(w.end > w.start);
    assert.ok(Number.isFinite(w.mean) && w.mean >= 0 && w.mean <= 10);
  }
});

test('a busy calendar removes windows entirely', () => {
  const fc = makeForecast('cullercoats', { days: 2 });
  const forecasts = new Map([['cullercoats', fc]]);
  const now = new Date(2026, 8, 1, 0, 0);
  const spots = [getSpot('cullercoats')];
  const craft = getCraft('surf-kayak');

  const free = findBestWindows(forecasts, spots, craft, settings, { now });
  // Block out every waking hour across the whole forecast.
  const busy = [{ start: new Date(2026, 8, 1, 0, 0), end: new Date(2026, 8, 4, 0, 0) }];
  const blocked = findBestWindows(forecasts, spots, craft, settings, { now, busy });

  assert.ok(free.length > 0);
  assert.equal(blocked.length, 0, 'a fully booked diary should yield no sessions');
});

test('the best spot is chosen per window across several spots', () => {
  // Longsands takes a northerly; Cullercoats does not.
  const northerly = (h) => ({ ...h, swellDirection: 350, waveDirection: 350 });
  const forecasts = new Map([
    ['cullercoats', makeForecast('cullercoats', { days: 2, hourFn: northerly })],
    ['longsands', makeForecast('longsands', { days: 2, hourFn: northerly })],
  ]);
  const out = findBestWindows(
    forecasts,
    [getSpot('cullercoats'), getSpot('longsands')],
    getCraft('surf-kayak'),
    settings,
    { now: new Date(2026, 8, 1, 0, 0) },
  );
  assert.ok(out.length > 0);
  assert.ok(out.every((w) => w.spot.id === 'longsands'), 'should pick the spot that works');
});

test('minWindowScore filters out the rubbish', () => {
  const fc = makeForecast('cullercoats', { days: 2, hourFn: (h) => ({ ...h, waveHeight: 0.05, swellHeight: 0.05 }) });
  const out = findBestWindows(new Map([['cullercoats', fc]]), [getSpot('cullercoats')], getCraft('surf-kayak'),
    { ...DEFAULT_SETTINGS, minWindowScore: 4 }, { now: new Date(2026, 8, 1, 0, 0) });
  assert.equal(out.length, 0, 'a flat week should offer nothing');
});
