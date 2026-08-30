import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seriesFor, consensus, agreement, agreementLabel, MARINE_MODEL_IDS } from '../js/sources.js';
import { buildForecast, mergeHourly } from '../js/api.js';
import { getSpot } from '../js/spots.js';
import { getCraft } from '../js/craft.js';
import { scoreHour } from '../js/scoring.js';

test('seriesFor collects both bare and model-suffixed columns', () => {
  const block = {
    wave_height: [1, 2],
    wave_height_ecmwf_wam025: [1.1, 2.1],
    wave_height_gwam: [0.9, 1.9],
    unrelated: [0, 0],
  };
  const got = seriesFor(block, 'wave_height', ['ecmwf_wam025', 'gwam', 'missing_model']);
  assert.equal(got.length, 3, 'bare column plus the two models present');
  assert.deepEqual(got[0], [1, 2]);
});

test('consensus takes the median, not the mean', () => {
  // One model wildly wrong must not drag the answer — that is the whole point
  // of asking several.
  const series = [[1.0], [1.1], [1.2], [9.0]];
  const r = consensus(series, 0);
  assert.equal(r.count, 4);
  assert.ok(r.value > 1.0 && r.value < 1.3, `median should ignore the outlier, got ${r.value}`);
  assert.equal(r.spread, 8.0, 'spread still reports the full disagreement');
});

test('consensus handles one model, no models and nulls', () => {
  assert.deepEqual(consensus([[2]], 0), { value: 2, spread: 0, count: 1 });
  assert.equal(consensus([], 0).count, 0);
  assert.ok(Number.isNaN(consensus([[null], [undefined]], 0).value));
  // A model that covers only part of the range shouldn't poison the rest.
  assert.equal(consensus([[1, null], [1.2, 1.4]], 1).value, 1.4);
});

test('agreement is high when models line up and low when they do not', () => {
  const tight = agreement({ waveHeight: 1.2, waveSpread: 0.1, windKn: 10, windSpread: 1 });
  const loose = agreement({ waveHeight: 1.2, waveSpread: 1.6, windKn: 10, windSpread: 14 });
  assert.ok(tight > 0.8, `expected agreement, got ${tight}`);
  assert.ok(loose < 0.3, `expected disagreement, got ${loose}`);
  assert.ok(tight >= 0 && tight <= 1 && loose >= 0 && loose <= 1);
});

test('agreement scales against magnitude, not absolute spread', () => {
  // 0.4 m apart on a 3 m swell is close; on a 0.5 m swell it is not.
  const big = agreement({ waveHeight: 3.0, waveSpread: 0.4, windKn: 12, windSpread: 2 });
  const small = agreement({ waveHeight: 0.5, waveSpread: 0.4, windKn: 12, windSpread: 2 });
  assert.ok(big > small);
});

test('agreement labels never promise more than the data supports', () => {
  assert.match(agreementLabel(0.9, 4).label, /agree/);
  assert.match(agreementLabel(0.1, 4).label, /disagree/);
  assert.match(agreementLabel(1, 1).label, /single model/);
  assert.equal(agreementLabel(NaN, 0).label, '');
});

test('buildForecast reads model-suffixed columns and reports the spread', () => {
  const times = ['2026-09-01T06:00', '2026-09-01T07:00'];
  const marine = {
    hourly: {
      time: times,
      wave_height_best_match: [1.0, 1.1],
      wave_height_ecmwf_wam025: [1.4, 1.5],
      wave_height_gwam: [0.8, 0.9],
      swell_wave_period_best_match: [9, 9],
      swell_wave_direction_best_match: [40, 40],
      sea_level_height_msl_best_match: [0.4, 0.9],
      sea_surface_temperature_best_match: [13, 13],
    },
  };
  const land = {
    hourly: {
      time: times,
      wind_speed_10m_best_match: [10, 11],
      wind_speed_10m_ecmwf_ifs025: [12, 13],
      wind_speed_10m_ukmo_seamless: [22, 23],
      wind_direction_10m_best_match: [250, 250],
      temperature_2m_best_match: [13, 13],
    },
    daily: { time: ['2026-09-01'], sunrise: ['2026-09-01T05:40'], sunset: ['2026-09-01T19:50'] },
  };

  const fc = buildForecast(getSpot('longsands'), marine, land);
  const h = fc.hours[0];

  assert.equal(h.waveHeight, 1.0, 'median of 0.8, 1.0, 1.4');
  assert.ok(Math.abs(h.waveSpread - 0.6) < 1e-9);
  assert.equal(h.windKn, 12, 'median of 10, 12, 22');
  assert.equal(h.modelCount, 3);
  assert.ok(h.agreement >= 0 && h.agreement <= 1);
  assert.equal(h.swellPeriod, 9, 'single-model variables still resolve');
});

test('buildForecast finds the time column even when it is model-suffixed', () => {
  // Open-Meteo suffixes every column, `time` included, once models= is set.
  const marine = {
    hourly: {
      time_best_match: ['2026-09-01T06:00'],
      wave_height_best_match: [1.2],
      sea_level_height_msl_best_match: [0.5],
    },
  };
  const land = {
    hourly: { time_best_match: ['2026-09-01T06:00'], wind_speed_10m_best_match: [8] },
    daily: { time: ['2026-09-01'], sunrise: ['2026-09-01T05:40'], sunset: ['2026-09-01T19:50'] },
  };
  const fc = buildForecast(getSpot('longsands'), marine, land);
  assert.equal(fc.hours.length, 1);
  assert.equal(fc.hours[0].waveHeight, 1.2);
});

test('a model missing entirely degrades rather than breaking', () => {
  const marine = { hourly: { time: ['2026-09-01T06:00'], wave_height_gwam: [1.0] } };
  const land = {
    hourly: { time: ['2026-09-01T06:00'], wind_speed_10m_gfs_seamless: [9], wind_direction_10m_gfs_seamless: [250] },
    daily: { time: ['2026-09-01'], sunrise: ['2026-09-01T05:40'], sunset: ['2026-09-01T19:50'] },
  };
  const fc = buildForecast(getSpot('longsands'), marine, land);
  assert.equal(fc.hours[0].waveHeight, 1.0);
  assert.equal(fc.hours[0].modelCount, 1);
  assert.ok(Number.isNaN(fc.hours[0].swellPeriod));
});

test('the marine model list is non-empty and unique', () => {
  assert.ok(MARINE_MODEL_IDS.length >= 2, 'a consensus needs more than one model');
  assert.equal(new Set(MARINE_MODEL_IDS).size, MARINE_MODEL_IDS.length);
});

test('sea temperature and sea level survive the multi-model wave request', () => {
  // Regression. The wave models (ECMWF WAM, DWD GWAM, Météo-France WAVE) do
  // not output sea surface temperature or sea level, so requesting those
  // alongside models= returned nothing: the sea temp vanished from the UI and,
  // far worse, the tide went silently flat with no high or low waters.
  // They now come from a second, single-model request merged in by timestamp.
  const times = ['2026-08-30T06:00', '2026-08-30T07:00', '2026-08-30T08:00'];

  const waves = {
    hourly: {
      time: times,
      wave_height_ecmwf_wam025: [0.9, 1.0, 1.1],
      wave_height_gwam: [0.8, 0.9, 1.0],
      swell_wave_period_ecmwf_wam025: [8, 8, 8],
    },
  };
  // The separate request: no model suffixes, because no models= was sent.
  const sea = {
    hourly: {
      time: times,
      sea_surface_temperature: [15.2, 15.2, 15.3],
      sea_level_height_msl: [-1.1, 0.2, 1.4],
    },
  };
  const land = {
    hourly: { time: times, wind_speed_10m_ecmwf_ifs025: [9, 9, 9], wind_direction_10m_ecmwf_ifs025: [250, 250, 250] },
    daily: { time: ['2026-08-30'], sunrise: ['2026-08-30T05:40'], sunset: ['2026-08-30T19:50'] },
  };

  const fc = buildForecast(getSpot('longsands'), mergeHourly(waves, sea), land);

  assert.equal(fc.hours[0].seaTemp, 15.2, 'sea temperature must survive the merge');
  assert.equal(fc.hours[0].seaLevel, -1.1, 'sea level must survive the merge');
  assert.ok(fc.hours.every((h) => Number.isFinite(h.tideNorm)), 'tide must be real, not a flat default');
  assert.ok(fc.hours[0].waveHeight > 0, 'and the multi-model waves still work');
});

test('mergeHourly aligns on timestamps rather than trusting row order', () => {
  const base = { hourly: { time: ['2026-08-30T06:00', '2026-08-30T07:00'], a: [1, 2] } };
  // Offset by an hour: a positional merge would smear these onto the wrong rows.
  const extra = { hourly: { time: ['2026-08-30T07:00', '2026-08-30T08:00'], b: [70, 80] } };
  const merged = mergeHourly(base, extra);

  assert.deepEqual(merged.hourly.a, [1, 2], 'base columns untouched');
  assert.equal(merged.hourly.b[0], null, 'no 06:00 value to take');
  assert.equal(merged.hourly.b[1], 70, '07:00 lines up with 07:00');
});

test('mergeHourly tolerates an empty or failed second request', () => {
  const base = { hourly: { time: ['2026-08-30T06:00'], a: [1] } };
  assert.deepEqual(mergeHourly(base, {}).hourly.a, [1]);
  assert.deepEqual(mergeHourly(base, { hourly: {} }).hourly.a, [1]);
});

test('losing the sea request costs the sea data, not the whole forecast', () => {
  // Splitting the marine call in two tripled the requests that can fail. With
  // Promise.all, one failing threw away the other two — so a transient error
  // on the sea endpoint left you with no forecast at all.
  const times = ['2026-08-30T06:00', '2026-08-30T07:00'];
  const waves = {
    hourly: {
      time: times,
      wave_height_ecmwf_wam025: [1.0, 1.1],
      swell_wave_period_ecmwf_wam025: [9, 9],
      swell_wave_direction_ecmwf_wam025: [45, 45],
    },
  };
  const land = {
    hourly: { time: times, wind_speed_10m_ecmwf_ifs025: [8, 8], wind_direction_10m_ecmwf_ifs025: [250, 250] },
    daily: { time: ['2026-08-30'], sunrise: ['2026-08-30T05:40'], sunset: ['2026-08-30T19:50'] },
  };

  // No mergeHourly call: this is what the code does when the sea request fails.
  const fc = buildForecast(getSpot('longsands'), waves, land);

  assert.ok(fc.hours[0].waveHeight > 0, 'waves must survive');
  assert.equal(fc.hours[0].windKn, 8, 'wind must survive');
  assert.ok(Number.isNaN(fc.hours[0].seaTemp), 'sea temp is the thing that is gone');
  assert.ok(Number.isNaN(fc.hours[0].tideNorm), 'and the tide is unknown, not faked');

  const r = scoreHour(fc.hours[0], getSpot('longsands'), getCraft('surf-kayak'));
  assert.ok(Number.isFinite(r.score) && r.score > 0, 'and it still produces a usable score');
});
