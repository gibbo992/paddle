// Open-Meteo — free, keyless, CORS-enabled, and it serves both the marine and
// the land forecast we need. Two endpoints, merged on the hour.
//
// Docs: https://open-meteo.com/en/docs/marine-weather-api
//       https://open-meteo.com/en/docs

import { parseLocal, kmhToKn, dayKey } from './util.js';
import { deriveTide, findExtremes, tideRegime } from './tide.js';

const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const MARINE_VARS = [
  'wave_height', 'wave_direction', 'wave_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
  'wind_wave_height', 'wind_wave_period',
  'sea_surface_temperature', 'sea_level_height_msl',
];

const LAND_VARS = [
  'temperature_2m', 'apparent_temperature', 'precipitation',
  'weather_code', 'cloud_cover',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];

export const FORECAST_DAYS = 7;
const CACHE_KEY = 'ksc:forecast:v1';
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

/** Column from an Open-Meteo hourly block, tolerant of a missing variable. */
const col = (block, name) => (block && Array.isArray(block[name]) ? block[name] : []);

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

  const marineUrl = `${MARINE_URL}?${qs({ ...common, hourly: MARINE_VARS.join(',') })}`;
  const landUrl = `${FORECAST_URL}?${qs({
    ...common,
    hourly: LAND_VARS.join(','),
    daily: 'sunrise,sunset',
    wind_speed_unit: 'kn',
  })}`;

  const [marine, land] = await Promise.all([
    getJson(marineUrl, signal),
    getJson(landUrl, signal),
  ]);

  return buildForecast(spot, marine, land);
}

/** Merge the two payloads into one hourly array. Exported so tests can feed it fixtures. */
export function buildForecast(spot, marine, land) {
  const mTime = col(marine.hourly, 'time');
  const lTime = col(land.hourly, 'time');

  // Index the land forecast by timestamp — the two endpoints agree on the hour,
  // but not necessarily on the array offset once past_days is involved.
  const landIndex = new Map(lTime.map((t, i) => [t, i]));

  const daily = buildDaily(land.daily);

  const hours = mTime.map((t, i) => {
    const j = landIndex.has(t) ? landIndex.get(t) : -1;
    const at = (block, name) => (j >= 0 ? col(block, name)[j] : undefined);

    const time = parseLocal(t);
    const day = daily.get(dayKey(time));

    const windKn = at(land.hourly, 'wind_speed_10m');
    const gustKn = at(land.hourly, 'wind_gusts_10m');

    return {
      time,
      iso: t,
      waveHeight: num(col(marine.hourly, 'wave_height')[i]),
      waveDirection: num(col(marine.hourly, 'wave_direction')[i]),
      wavePeriod: num(col(marine.hourly, 'wave_period')[i]),
      swellHeight: num(col(marine.hourly, 'swell_wave_height')[i]),
      swellDirection: num(col(marine.hourly, 'swell_wave_direction')[i]),
      swellPeriod: num(col(marine.hourly, 'swell_wave_period')[i]),
      windWaveHeight: num(col(marine.hourly, 'wind_wave_height')[i]),
      windWavePeriod: num(col(marine.hourly, 'wind_wave_period')[i]),
      seaTemp: num(col(marine.hourly, 'sea_surface_temperature')[i]),
      seaLevel: num(col(marine.hourly, 'sea_level_height_msl')[i]),

      airTemp: num(at(land.hourly, 'temperature_2m')),
      apparentTemp: num(at(land.hourly, 'apparent_temperature')),
      precip: num(at(land.hourly, 'precipitation')),
      weatherCode: num(at(land.hourly, 'weather_code')),
      cloudCover: num(at(land.hourly, 'cloud_cover')),
      // wind_speed_unit=kn means these arrive in knots already; guard anyway in
      // case a caller ever drops the unit param.
      windKn: num(windKn),
      windGustKn: num(gustKn),
      windDirection: num(at(land.hourly, 'wind_direction_10m')),

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

  return {
    spotId: spot.id,
    fetchedAt: Date.now(),
    hours,
    daily,
    tideEvents: findExtremes(hours),
    tideRegime: tideRegime(hours),
    units: { wave: 'm', wind: 'kn', temp: '°C' },
  };
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

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

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
