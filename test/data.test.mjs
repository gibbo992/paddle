import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTide, findExtremes, tideRegime } from '../js/tide.js';
import { kitAdvice, safetyFlags } from '../js/kit.js';
import { buildForecast } from '../js/api.js';
import { scoreHour } from '../js/scoring.js';
import { getSpot } from '../js/spots.js';
import { getCraft } from '../js/craft.js';
import { hour } from './fixtures.mjs';

function sineTide(hours = 96, amplitude = 2.3) {
  const t0 = new Date(2026, 8, 1, 0, 0);
  return Array.from({ length: hours }, (_, i) => ({
    time: new Date(+t0 + i * 3600e3),
    seaLevel: amplitude * Math.sin((2 * Math.PI * i) / 12.42),
  }));
}

test('tide normalisation spans 0..1 over a cycle', () => {
  const series = sineTide();
  const t = deriveTide(series);
  // Skip the first and last 6 h — those windows are clipped by design.
  const mid = t.slice(7, -7);
  assert.ok(Math.min(...mid.map((x) => x.norm)) < 0.05);
  assert.ok(Math.max(...mid.map((x) => x.norm)) > 0.95);
  assert.ok(mid.every((x) => x.norm >= 0 && x.norm <= 1));
});

test('rising and falling are identified correctly', () => {
  const series = sineTide();
  const t = deriveTide(series);
  // A sine peaks around i=3 and troughs around i=9.
  assert.equal(t[12].state, 'rising');
  assert.equal(t[15].state, 'rising');
  assert.match(t[3].state, /high/);
  assert.match(t[9].state, /low/);
});

test('high and low waters alternate', () => {
  const events = findExtremes(sineTide());
  assert.ok(events.length >= 12);
  for (let i = 1; i < events.length; i++) {
    assert.notEqual(events[i].kind, events[i - 1].kind, 'highs and lows must alternate');
  }
});

test('springs and neaps are told apart by range', () => {
  assert.equal(tideRegime(sineTide(96, 2.4)).forDate(new Date(2026, 8, 1, 12)).label, 'springs');
  assert.equal(tideRegime(sineTide(96, 1.2)).forDate(new Date(2026, 8, 1, 12)).label, 'neaps');
  assert.ok(tideRegime(sineTide(96, 2.4)).forDate(new Date(2026, 8, 1, 12)).spring);
});

test('a flat or missing sea level reads as unknown, not as mid tide', () => {
  // This test previously asserted the opposite — that flat data must still
  // produce a finite tide value. That assertion was defending a bug: a silent
  // 0.5 is indistinguishable downstream from a genuine mid tide, so when the
  // sea level series went missing every spot's tide preference was quietly
  // cancelled and nothing said so.
  const flat = sineTide(48, 0);
  const t = deriveTide(flat);
  assert.ok(t.every((x) => Number.isNaN(x.norm)), 'no data must not masquerade as mid tide');
  assert.ok(t.every((x) => x.state === 'unknown'));

  // And it must degrade rather than throw.
  const r = scoreHour(hour({ tideNorm: NaN, tideState: 'unknown' }), getSpot('longsands'), getCraft('surf-kayak'));
  assert.ok(Number.isFinite(r.score));
});

test('a missing tide is announced, not hidden', () => {
  const spot = getSpot('blyth');
  const craft = getCraft('surf-kayak');
  const h = hour({ tideNorm: NaN, tideState: 'unknown' });
  const flags = safetyFlags({
    scored: scoreHour(h, spot, craft), hour: h, spot, craft,
    regime: { spring: false, rangeM: NaN },
  });
  assert.ok(flags.some((f) => f.code === 'no-tide'), 'expected a flag when the tide is unknown');
});

test('kit advice tracks sea temperature', () => {
  assert.match(kitAdvice(6, 6).suit, /Drysuit/);
  assert.match(kitAdvice(15, 15).suit, /4\/3/);
  assert.match(kitAdvice(18, 20).suit, /3\/2|Shorty/);
  assert.deepEqual(kitAdvice(12, 12).always, ['Helmet', 'Buoyancy aid', 'Reliable roll or a partner']);
});

test('wind chill pushes you into a warmer suit', () => {
  const calm = kitAdvice(14, 14);
  const bitter = kitAdvice(14, 2);
  assert.notEqual(calm.suit, bitter.suit);
  assert.ok(bitter.chillNote, 'expected a wind chill note');
});

test('kit advice survives missing sea temperature', () => {
  const k = kitAdvice(NaN, 10);
  assert.ok(Array.isArray(k.extras));
  assert.match(k.suit, /No sea temp/);
});

test('safety flags fire on cold water and spring-tide rips', () => {
  const h = hour({ seaTemp: 8, waveHeight: 1.8 });
  const spot = getSpot('longsands');
  const craft = getCraft('surf-kayak');
  const scored = scoreHour(h, spot, craft);
  const flags = safetyFlags({
    scored, hour: h, spot, craft,
    regime: { spring: true, rangeM: 4.6, label: 'springs' },
  });
  const codes = flags.map((f) => f.code);
  assert.ok(codes.includes('cold-water'));
  assert.ok(codes.includes('spring-rips'));
});

test('safety flags do not duplicate codes', () => {
  const h = hour({ windKn: 30, windDirection: 250, seaTemp: 7 });
  const spot = getSpot('cullercoats');
  const craft = getCraft('surf-kayak');
  const scored = scoreHour(h, spot, craft);
  const flags = safetyFlags({ scored, hour: h, spot, craft, regime: { spring: false, rangeM: 3 } });
  const codes = flags.map((f) => f.code);
  assert.equal(new Set(codes).size, codes.length);
});

test('buildForecast merges marine and land payloads on matching timestamps', () => {
  const times = ['2026-09-01T00:00', '2026-09-01T01:00', '2026-09-01T02:00'];
  const marine = {
    hourly: {
      time: times,
      wave_height: [1.0, 1.1, 1.2],
      wave_direction: [65, 66, 67],
      wave_period: [8, 8, 8],
      swell_wave_height: [0.9, 1.0, 1.1],
      swell_wave_direction: [64, 65, 66],
      swell_wave_period: [9, 9, 9],
      sea_surface_temperature: [14, 14, 14],
      sea_level_height_msl: [0.1, 0.6, 1.1],
    },
  };
  const land = {
    hourly: {
      time: times,
      temperature_2m: [13, 13, 12],
      apparent_temperature: [11, 11, 10],
      precipitation: [0, 0, 0.2],
      wind_speed_10m: [8, 9, 10],
      wind_direction_10m: [250, 250, 245],
      wind_gusts_10m: [12, 13, 15],
    },
    daily: { time: ['2026-09-01'], sunrise: ['2026-09-01T05:40'], sunset: ['2026-09-01T19:50'] },
  };

  const fc = buildForecast(getSpot('cullercoats'), marine, land);
  assert.equal(fc.hours.length, 3);
  assert.equal(fc.hours[0].waveHeight, 1.0);
  assert.equal(fc.hours[0].windKn, 8);
  assert.equal(fc.hours[0].airTemp, 13);
  assert.ok(fc.hours.every((h) => Number.isFinite(h.tideNorm)));
  assert.equal(fc.hours[0].daylight, false, '00:00 is before first light');
});

test('buildForecast aligns by timestamp, not array position', () => {
  // The land payload starts an hour later — a positional merge would smear the data.
  const marine = {
    hourly: {
      time: ['2026-09-01T00:00', '2026-09-01T01:00'],
      wave_height: [1.0, 1.1],
      sea_level_height_msl: [0.1, 0.6],
    },
  };
  const land = {
    hourly: { time: ['2026-09-01T01:00'], temperature_2m: [13], wind_speed_10m: [8], wind_direction_10m: [250] },
    daily: { time: ['2026-09-01'], sunrise: ['2026-09-01T05:40'], sunset: ['2026-09-01T19:50'] },
  };
  const fc = buildForecast(getSpot('cullercoats'), marine, land);
  assert.ok(Number.isNaN(fc.hours[0].airTemp), 'no land data for 00:00');
  assert.equal(fc.hours[1].airTemp, 13, 'land data lands on 01:00');
});

test('buildForecast tolerates a missing marine variable', () => {
  const marine = { hourly: { time: ['2026-09-01T06:00'], wave_height: [1.0] } };
  const land = {
    hourly: { time: ['2026-09-01T06:00'], temperature_2m: [13], wind_speed_10m: [8], wind_direction_10m: [250] },
    daily: { time: ['2026-09-01'], sunrise: ['2026-09-01T05:40'], sunset: ['2026-09-01T19:50'] },
  };
  const fc = buildForecast(getSpot('cullercoats'), marine, land);
  assert.ok(Number.isNaN(fc.hours[0].swellPeriod));
  const r = scoreHour(fc.hours[0], getSpot('cullercoats'), getCraft('surf-kayak'));
  assert.ok(Number.isFinite(r.score));
});
