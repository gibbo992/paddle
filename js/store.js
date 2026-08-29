// Settings, persisted to localStorage. Everything here is meant to be edited
// from the Settings sheet — the defaults are just a sensible starting point.

import { DEFAULT_SPOT_ID } from './spots.js';
import { DEFAULT_CRAFT_ID } from './craft.js';

const KEY = 'ksc:settings:v1';

export const DEFAULT_SETTINGS = {
  spotId: DEFAULT_SPOT_ID,
  craftId: DEFAULT_CRAFT_ID,
  enabledSpots: ['cullercoats', 'longsands', 'kingedwards', 'whitley', 'seaton-sluice', 'blyth'],

  units: { height: 'ft', wind: 'kn' },

  // Session shape
  minSessionMins: 75,     // in the water long enough to be worth changing for
  travelMins: 15,         // padding either side of a calendar commitment
  daylightOnly: true,
  minWindowScore: 4.0,    // don't bother listing anything below this

  rules: [
    { id: 'dawn', label: 'Before work', days: [1, 2, 3, 4, 5], start: '05:30', end: '08:15', enabled: true },
    { id: 'evening', label: 'After work', days: [1, 2, 3, 4, 5], start: '16:45', end: '21:00', enabled: true },
    { id: 'weekend', label: 'Weekend', days: [0, 6], start: '06:30', end: '19:00', enabled: true },
  ],

  google: {
    enabled: false,
    clientId: '',
    calendarIds: [],
  },
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== 'object' || base === null) return patch ?? base;
  if (typeof patch !== 'object' || patch === null) return base;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* private mode — the app still works, it just forgets */ }
  return settings;
}

export function resetSettings() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return structuredClone(DEFAULT_SETTINGS);
}
