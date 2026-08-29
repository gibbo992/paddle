// Synthetic forecast for `?demo=1`. Lets the app be opened and driven without
// network access — handy for trying the layout, and for testing.
//
// The numbers are shaped like a real North Sea week: a NE groundswell filling
// in mid-week, a windy spell, and a semidiurnal tide.

import { buildForecast } from './api.js';
import { isoLocal } from './util.js';

export function demoForecast(spot, days = 7) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1); // matches past_days=1

  const n = (days + 1) * 24;
  const time = [];
  const cols = {
    wave_height: [], wave_direction: [], wave_period: [],
    swell_wave_height: [], swell_wave_direction: [], swell_wave_period: [],
    sea_surface_temperature: [], sea_level_height_msl: [],
  };
  const land = {
    temperature_2m: [], apparent_temperature: [], precipitation: [],
    wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [],
  };

  // Seed the spot id so different spots differ but stay stable across reloads.
  let seed = [...spot.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < n; i++) {
    const t = new Date(+start + i * 3600e3);
    time.push(isoLocal(t));
    const d = i / 24;

    // A swell that builds to a peak around day 3 and eases off.
    const swell = 0.45 + 1.15 * Math.exp(-((d - 3.2) ** 2) / 2.2) + 0.12 * Math.sin(i / 5) + rand() * 0.1;
    const period = 6.2 + 4.0 * Math.exp(-((d - 3.4) ** 2) / 3.0) + rand() * 0.6;
    const dir = 58 + 22 * Math.sin(d / 2.3) + rand() * 8;

    cols.wave_height.push(round2(swell));
    cols.swell_wave_height.push(round2(swell * 0.92));
    cols.wave_period.push(round2(period));
    cols.swell_wave_period.push(round2(period + 0.6));
    cols.wave_direction.push(Math.round(dir));
    cols.swell_wave_direction.push(Math.round(dir));
    cols.sea_surface_temperature.push(round2(13.8 + 0.4 * Math.sin(i / 30)));

    // Springs: a semidiurnal tide with a slow spring/neap envelope.
    const envelope = 1.65 + 0.75 * Math.sin((d + 1.5) / 6.4);
    cols.sea_level_height_msl.push(round2(envelope * Math.sin((2 * Math.PI * i) / 12.42)));

    // Wind: light offshore at dawn, building onshore through the afternoon,
    // with a blowy day around day 4.
    const hourOfDay = t.getHours();
    const diurnal = Math.max(0, Math.sin(((hourOfDay - 7) / 24) * Math.PI * 2));
    const gale = 14 * Math.exp(-((d - 4.5) ** 2) / 0.7);
    const speed = 4 + 9 * diurnal + gale + rand() * 3;
    const wdir = 248 - 150 * diurnal - 40 * Math.exp(-((d - 4.5) ** 2) / 0.9);

    land.wind_speed_10m.push(round2(speed));
    land.wind_gusts_10m.push(round2(speed * 1.45));
    land.wind_direction_10m.push(Math.round((wdir + 360) % 360));

    const air = 14.5 + 4.5 * Math.sin(((hourOfDay - 4) / 24) * Math.PI * 2) - 0.4 * d;
    land.temperature_2m.push(round2(air));
    land.apparent_temperature.push(round2(air - 1.6 - speed * 0.14));
    land.precipitation.push(d > 4.1 && d < 4.7 && rand() > 0.6 ? round2(rand() * 3) : 0);
  }

  // Sunrise/sunset roughly right for 55°N, moving a little across the week.
  const dailyTime = [];
  const sunrise = [];
  const sunset = [];
  for (let dd = 0; dd <= days; dd++) {
    const day = new Date(+start + dd * 86400e3);
    const key = isoLocal(day).slice(0, 10);
    dailyTime.push(key);
    sunrise.push(`${key}T0${5 + (dd % 2 ? 0 : 0)}:${dd % 2 ? '48' : '42'}`);
    sunset.push(`${key}T19:${dd % 2 ? '58' : '52'}`);
  }

  return buildForecast(
    spot,
    { hourly: { time, ...cols } },
    { hourly: { time, ...land }, daily: { time: dailyTime, sunrise, sunset } },
  );
}

const round2 = (v) => Math.round(v * 100) / 100;

export const isDemo = () => new URLSearchParams(location.search).has('demo');
