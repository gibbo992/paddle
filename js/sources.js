// Multiple forecast models, not one.
//
// A single model is a single opinion. Open-Meteo will serve several national
// weather services from the same endpoint, so asking for four and comparing
// them costs one extra request and buys something a single source cannot give:
// a measure of how much to trust the number. When ECMWF and UKMO agree on
// 1.2 m, that is a different fact from one saying 0.6 and another saying 1.8.
//
// Keyless and CORS-enabled, which matters because this app has no server to
// hide a key in. Met Office DataHub, StormGlass and the rest all need one.

/** Wave models. `best_match` is Open-Meteo's own blend. */
export const MARINE_MODELS = [
  { id: 'best_match', label: 'Blend' },
  { id: 'ecmwf_wam025', label: 'ECMWF WAM' },
  { id: 'gwam', label: 'DWD GWAM' },
  { id: 'meteofrance_wave', label: 'Météo-France' },
];

/** Atmospheric models, for wind and temperature. */
export const WEATHER_MODELS = [
  { id: 'best_match', label: 'Blend' },
  { id: 'ecmwf_ifs025', label: 'ECMWF' },
  { id: 'gfs_seamless', label: 'NOAA GFS' },
  { id: 'ukmo_seamless', label: 'Met Office' },
];

export const MARINE_MODEL_IDS = MARINE_MODELS.map((m) => m.id);
export const WEATHER_MODEL_IDS = WEATHER_MODELS.map((m) => m.id);

/**
 * Every series Open-Meteo returned for one variable.
 *
 * With `models=` set it suffixes each column with the model id; without it
 * there is a single bare column. Both shapes are handled so fixtures and
 * older cached payloads still parse.
 */
export function seriesFor(block, name, modelIds) {
  if (!block) return [];
  const out = [];
  if (Array.isArray(block[name])) out.push(block[name]);
  for (const id of modelIds || []) {
    const key = `${name}_${id}`;
    if (Array.isArray(block[key])) out.push(block[key]);
  }
  return out;
}

/**
 * Combine one hour across models.
 *
 * Median rather than mean: one model going badly wrong should not drag the
 * answer with it, which is the whole reason for asking several.
 *
 * @returns {{value: number, spread: number, count: number}}
 */
export function consensus(series, i) {
  const vals = [];
  for (const s of series) {
    const v = s[i];
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return { value: NaN, spread: NaN, count: 0 };
  if (vals.length === 1) return { value: vals[0], spread: 0, count: 1 };

  vals.sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const value = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return { value, spread: vals[vals.length - 1] - vals[0], count: vals.length };
}

/**
 * How much the models agree, 0..1, from the spread on the two things that
 * actually decide a session: wave height and wind speed.
 *
 * Scaled against the magnitude, because half a metre of disagreement on a
 * half-metre swell is a different matter from half a metre on three.
 */
export function agreement({ waveHeight, waveSpread, windKn, windSpread }) {
  const parts = [];

  if (Number.isFinite(waveSpread) && Number.isFinite(waveHeight)) {
    // 0.25 m floor: below that the models are arguing about nothing.
    const rel = waveSpread / Math.max(0.25, Math.abs(waveHeight));
    parts.push(clamp01(1 - rel / 0.9));
  }
  if (Number.isFinite(windSpread) && Number.isFinite(windKn)) {
    const rel = windSpread / Math.max(5, Math.abs(windKn));
    parts.push(clamp01(1 - rel / 1.1));
  }
  if (!parts.length) return NaN;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Words for an agreement figure, plus how much to trust the headline number. */
export function agreementLabel(a, count) {
  if (!Number.isFinite(a) || !count) return { label: '', tone: 'none', short: '' };
  if (count < 2) return { label: 'single model', tone: 'warning', short: '1 model' };
  if (a >= 0.8) return { label: `${count} models agree`, tone: 'good', short: 'agreed' };
  if (a >= 0.55) return { label: `${count} models roughly agree`, tone: 'good', short: 'roughly agreed' };
  if (a >= 0.3) return { label: `${count} models differ`, tone: 'warning', short: 'uncertain' };
  return { label: `${count} models disagree sharply`, tone: 'serious', short: 'unreliable' };
}
