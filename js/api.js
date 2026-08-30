// Open-Meteo — free, keyless, CORS-enabled, and it serves both the marine and
// the land forecast we need. Two endpoints, merged on the hour.
//
// Docs: https://open-meteo.com/en/docs/marine-weather-api
//       https://open-meteo.com/en/docs

import { parseLocal, dayKey } from './util.js';
import { deriveTide, findExtremes, tideRegime } from './tide.js';
import { annotateTrend } from './trend.js';
import {
  MARINE_MODEL_IDS, WEATHER_MODEL_IDS, seriesFor, consensus, agreement,
} from './sources.js';

const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Wave variables, which the wave models all provide.
const WAVE_VARS = [
  'wave_height', 'wave_direction', 'wave_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
  'wind_wave_height', 'wind_wave_period',
];

// Sea temperature and sea level are NOT wave-model outputs. ECMWF WAM, DWD
// GWAM and Météo-France WAVE model the sea surface, not its temperature or
// the tide, so asking for these alongside `models=` returns nothing at all.
// That silently emptied the sea temp AND the sea level — which left the tide
// pinned flat at mid with no high or low waters, quietly cancelling every
// spot's tide preference. They get their own request, on the default model.
const SEA_VARS = ['sea_surface_temperature', 'sea_level_height_msl'];

const MARINE_VARS = [...WAVE_VARS, ...SEA_VARS];

const LAND_VARS = [
  'temperature_2m', 'apparent_temperature', 'precipitation',
  'weather_code', 'cloud_cover',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];

export const FORECAST_DAYS = 7;
// v2: cached payloads now carry model spread, so v1 entries are dropped.
// v3: v2 entries were cached with an empty sea level and a flat tide.
const CACHE_KEY = 'ksc:forecast:v3';
const CACHE_TTL_MS = 30 * 60 * 1000; // Open-Meteo refreshes hourly; 30 min is plenty.

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  const json = await res.json();
  if (json.error) throw new Error(json.reason || 'API error');
  return json;
}

/**
 * Fetch and merge one spot's forecast.
 * `past_days=1` matters: deriveTide needs ~6 h of history either side of a
 * sample to bracket a full tidal cycle, so without it "now" would be scored
 * against a clipped window.
 */
export async function fetchSpotForecast(spot, { signal, days = FORECAST_DAYS } = {}) {
  const common = {
    latitude: spot.lat,
    longitude: spot.lon,
    timezone: 'Europe/London',
    forecast_days: days,
    past_days: 1,
  };

  // Several models per request. One model is one opinion; four give a
  // headline number AND a measure of how much to trust it.
  const waveUrl = `${MARINE_URL}?${qs({
    ...common,
    hourly: WAVE_VARS.join(','),
    models: MARINE_MODEL_IDS.join(','),
  })}`;
  // Sea temperature and tide, single model — see SEA_VARS above.
  const seaUrl = `${MARINE_URL}?${qs({ ...common, hourly: SEA_VARS.join(',') })}`;
  const landUrl = `${FORECAST_URL}?${qs({
    ...common,
    hourly: LAND_VARS.join(','),
    daily: 'sunrise,sunset',
    wind_speed_unit: 'kn',
    models: WEATHER_MODEL_IDS.join(','),
  })}`;

  // allSettled, not all. Splitting the marine call in two tripled the number
  // of requests that can fail, and with Promise.all any one of them failing
  // threw away the other two. Waves and weather are load-bearing — without
  // them there is no forecast — but losing the sea request should cost you the
  // sea temperature and the tide, not the whole thing.
  const [wavesR, seaR, landR] = await Promise.allSettled([
    getJson(waveUrl, signal),
    getJson(seaUrl, signal),
    getJson(landUrl, signal),
  ]);

  if (wavesR.status === 'rejected') throw wavesR.reason;
  if (landR.status === 'rejected') throw landR.reason;

  const sea = seaR.status === 'fulfilled' ? seaR.value : null;
  const marine = sea ? mergeHourly(wavesR.value, sea) : wavesR.value;

  const forecast = buildForecast(spot, marine, landR.value);
  if (!sea) forecast.missing = ['sea temperature', 'tide'];
  return forecast;
}

/** Merge the two payloads into one hourly array. Exported so tests can feed it fixtures. */
export function buildForecast(spot, marine, land) {
  const mTime = firstTime(marine.hourly);
  const lTime = firstTime(land.hourly);

  // Index the land forecast by timestamp — the two endpoints agree on the hour,
  // but not necessarily on the array offset once past_days is involved.
  const landIndex = new Map(lTime.map((t, i) => [t, i]));

  const daily = buildDaily(land.daily);

  // Resolve each variable to its per-model series once, rather than per hour.
  const M = (name) => seriesFor(marine.hourly, name, MARINE_MODEL_IDS);
  const L = (name) => seriesFor(land.hourly, name, WEATHER_MODEL_IDS);

  const marineSeries = Object.fromEntries(MARINE_VARS.map((v) => [v, M(v)]));
  const landSeries = Object.fromEntries(LAND_VARS.map((v) => [v, L(v)]));

  const hours = mTime.map((t, i) => {
    const j = landIndex.has(t) ? landIndex.get(t) : -1;

    const mv = (name) => consensus(marineSeries[name], i);
    const lv = (name) => (j >= 0 ? consensus(landSeries[name], j) : EMPTY);

    const time = parseLocal(t);
    const day = daily.get(dayKey(time));

    const wave = mv('wave_height');
    const wind = lv('wind_speed_10m');

    return {
      time,
      iso: t,
      waveHeight: wave.value,
      waveDirection: mv('wave_direction').value,
      wavePeriod: mv('wave_period').value,
      swellHeight: mv('swell_wave_height').value,
      swellDirection: mv('swell_wave_direction').value,
      swellPeriod: mv('swell_wave_period').value,
      windWaveHeight: mv('wind_wave_height').value,
      windWavePeriod: mv('wind_wave_period').value,
      seaTemp: mv('sea_surface_temperature').value,
      seaLevel: mv('sea_level_height_msl').value,

      airTemp: lv('temperature_2m').value,
      apparentTemp: lv('apparent_temperature').value,
      precip: lv('precipitation').value,
      weatherCode: lv('weather_code').value,
      cloudCover: lv('cloud_cover').value,
      // wind_speed_unit=kn means these arrive in knots already.
      windKn: wind.value,
      windGustKn: lv('wind_gusts_10m').value,
      windDirection: lv('wind_direction_10m').value,

      // How much the models argue, and about what.
      waveSpread: wave.spread,
      windSpread: wind.spread,
      modelCount: Math.max(wave.count, wind.count),
      agreement: agreement({
        waveHeight: wave.value, waveSpread: wave.spread,
        windKn: wind.value, windSpread: wind.spread,
      }),

      sunrise: day?.sunrise ?? null,
      sunset: day?.sunset ?? null,
      daylight: day ? (time >= day.lightFrom && time <= day.lightTo) : null,
    };
  });

  const tide = deriveTide(hours);
  hours.forEach((h, i) => {
    h.tideNorm = tide[i].norm;
    h.tideState = tide[i].state;
    h.tideRangeM = tide[i].rangeM;
  });
  annotateTrend(hours);

  return {
    spotId: spot.id,
    fetchedAt: Date.now(),
    hours,
    daily,
    tideEvents: findExtremes(hours),
    tideRegime: tideRegime(hours),
    health: dataHealth(hours),
    units: { wave: 'm', wind: 'kn', temp: '°C' },
  };
}

/**
 * Which fields actually came back, and from how many models.
 *
 * Two bugs in two days came from the payload not being the shape assumed, and
 * both presented as a quiet blank rather than an error. This makes the answer
 * checkable without a debugger.
 */
const HEALTH_FIELDS = [
  ['waveHeight', 'Wave height'],
  ['swellPeriod', 'Swell period'],
  ['swellDirection', 'Swell direction'],
  ['seaLevel', 'Sea level (tide)'],
  ['seaTemp', 'Sea temperature'],
  ['windKn', 'Wind speed'],
  ['windDirection', 'Wind direction'],
  ['airTemp', 'Air temperature'],
];

export function dataHealth(hours) {
  const total = hours.length;
  const fields = HEALTH_FIELDS.map(([key, label]) => {
    const present = hours.reduce((n, h) => n + (Number.isFinite(h[key]) ? 1 : 0), 0);
    return { key, label, present, total, ok: present > total * 0.5 };
  });
  return {
    fields,
    hours: total,
    models: hours.length ? Math.max(...hours.map((h) => h.modelCount || 0)) : 0,
    missing: fields.filter((f) => !f.ok).map((f) => f.label),
  };
}

const EMPTY = { value: NaN, spread: NaN, count: 0 };

/**
 * Fold a second payload's hourly columns into the first, aligned by timestamp.
 * Both requests carry identical parameters so the rows should line up, but
 * matching on the timestamp costs nothing and cannot silently skew the series.
 */
export function mergeHourly(base, extra) {
  const baseTime = firstTime(base?.hourly);
  const extraTime = firstTime(extra?.hourly);
  if (!baseTime.length || !extraTime.length) return base;

  const at = new Map(extraTime.map((t, i) => [t, i]));
  const hourly = { ...base.hourly };
  for (const [key, series] of Object.entries(extra.hourly)) {
    if (key === 'time' || key.startsWith('time_') || !Array.isArray(series)) continue;
    hourly[key] = baseTime.map((t) => (at.has(t) ? series[at.get(t)] : null));
  }
  return { ...base, hourly };
}

/**
 * The time column. With `models=` set Open-Meteo suffixes every column
 * including `time`, so fall back to the first suffixed one it finds.
 */
function firstTime(block) {
  if (!block) return [];
  if (Array.isArray(block.time)) return block.time;
  for (const key of Object.keys(block)) {
    if (key.startsWith('time_') && Array.isArray(block[key])) return block[key];
  }
  return [];
}

function buildDaily(daily) {
  const out = new Map();
  const times = daily?.time || [];
  times.forEach((d, i) => {
    const sunrise = daily.sunrise?.[i] ? parseLocal(daily.sunrise[i]) : null;
    const sunset = daily.sunset?.[i] ? parseLocal(daily.sunset[i]) : null;
    // You can comfortably paddle in civil twilight either side of the sun.
    const pad = 25 * 60 * 1000;
    out.set(d, {
      date: parseLocal(`${d}T12:00`),
      sunrise,
      sunset,
      lightFrom: sunrise ? new Date(sunrise.getTime() - pad) : null,
      lightTo: sunset ? new Date(sunset.getTime() + pad) : null,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Caching. The service worker caches the shell; this caches the data, so the
// app opens with something on screen in a car park with one bar of signal.
// ---------------------------------------------------------------------------

export function readCache(spotId) {
  try {
    const raw = localStorage.getItem(`${CACHE_KEY}:${spotId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return reviveForecast(parsed);
  } catch {
    return null;
  }
}

export function writeCache(spotId, forecast) {
  try {
    localStorage.setItem(`${CACHE_KEY}:${spotId}`, JSON.stringify({
      fetchedAt: forecast.fetchedAt,
      spotId,
      missing: forecast.missing || null,
      hours: forecast.hours.map((h) => ({ ...h, time: h.iso })),
      daily: [...forecast.daily.entries()].map(([k, v]) => [k, {
        sunrise: v.sunrise?.toISOString() ?? null,
        sunset: v.sunset?.toISOString() ?? null,
      }]),
    }));
  } catch { /* quota or private mode — caching is a nicety, not a requirement */ }
}

function reviveForecast(parsed) {
  const hours = parsed.hours.map((h) => ({ ...h, time: parseLocal(h.time), iso: h.time }));
  const daily = new Map((parsed.daily || []).map(([k, v]) => {
    const sunrise = v.sunrise ? new Date(v.sunrise) : null;
    const sunset = v.sunset ? new Date(v.sunset) : null;
    const pad = 25 * 60 * 1000;
    return [k, {
      date: parseLocal(`${k}T12:00`),
      sunrise, sunset,
      lightFrom: sunrise ? new Date(sunrise.getTime() - pad) : null,
      lightTo: sunset ? new Date(sunset.getTime() + pad) : null,
    }];
  }));
  return {
    ...parsed,
    hours,
    daily,
    tideEvents: findExtremes(hours),
    tideRegime: tideRegime(hours),
    stale: Date.now() - parsed.fetchedAt > CACHE_TTL_MS,
  };
}

export function isFresh(forecast) {
  return forecast && Date.now() - forecast.fetchedAt < CACHE_TTL_MS;
}

/** Fetch with a cache read-through. Returns {forecast, fromCache, error}. */
export async function loadSpot(spot, { force = false, signal } = {}) {
  const cached = readCache(spot.id);
  if (!force && isFresh(cached)) return { forecast: cached, fromCache: true, error: null };

  try {
    const forecast = await fetchSpotForecast(spot, { signal });
    writeCache(spot.id, forecast);
    return { forecast, fromCache: false, error: null };
  } catch (error) {
    if (cached) return { forecast: cached, fromCache: true, error };
    return { forecast: null, fromCache: false, error };
  }
}
