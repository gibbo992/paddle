// What to wear, and what to be wary of. North Sea water runs roughly 6–8 °C in
// late winter and 14–16 °C at the back end of summer, so the kit call changes a
// lot across the year and wind chill on a wet cag changes it again.

import { clamp } from './util.js';

const SUITS = [
  { max: 7,  suit: 'Drysuit + thermals', extras: ['Neoprene hood', 'Gloves or pogies', '5 mm boots'] },
  { max: 10, suit: 'Drysuit, or 5/4 + hood', extras: ['Hood', 'Gloves', 'Boots'] },
  { max: 13, suit: '5/4 or 4/3 steamer', extras: ['Boots', 'Hood if it is windy', 'Gloves optional'] },
  { max: 16, suit: '4/3 steamer', extras: ['Boots', 'Cag over the top if windy'] },
  { max: 19, suit: '3/2 steamer', extras: ['Boots optional'] },
  { max: 99, suit: 'Shorty or 3/2', extras: [] },
];

/**
 * @param {number} seaTempC
 * @param {number} apparentAirC  "feels like" air temp — carries the wind chill
 */
export function kitAdvice(seaTempC, apparentAirC) {
  const sea = Number.isFinite(seaTempC) ? seaTempC : NaN;
  if (!Number.isFinite(sea)) {
    return { suit: 'No sea temp available', extras: [], always: ALWAYS, chillNote: null };
  }

  // A cold wind on a wet paddler effectively drops the water band you dress for.
  let band = sea;
  if (Number.isFinite(apparentAirC) && apparentAirC < sea - 4) {
    band -= clamp((sea - apparentAirC) * 0.4, 0, 3);
  }

  const pick = SUITS.find((s) => band <= s.max) || SUITS[SUITS.length - 1];

  let chillNote = null;
  if (Number.isFinite(apparentAirC) && apparentAirC < 4) {
    chillNote = `Feels like ${Math.round(apparentAirC)} °C in the wind — the change afterwards will be worse than the paddle.`;
  } else if (Number.isFinite(apparentAirC) && apparentAirC < sea - 6) {
    chillNote = `Air feels colder than the sea (${Math.round(apparentAirC)} °C vs ${Math.round(sea)} °C). Dress for the wind, not the water.`;
  }

  return { suit: pick.suit, extras: pick.extras, always: ALWAYS, chillNote, seaTempC: sea };
}

const ALWAYS = ['Helmet', 'Buoyancy aid', 'Reliable roll or a partner'];

/**
 * Session-level safety flags — the things that turn a fun score into a bad idea.
 * Returns {level, code, text} where level ∈ good|warning|serious|critical.
 */
export function safetyFlags({ scored, hour, spot, craft, regime }) {
  const out = [...(scored.flags || [])];

  const seen = new Set(out.map((f) => f.code));
  const add = (f) => { if (!seen.has(f.code)) { seen.add(f.code); out.push(f); } };

  if (Number.isFinite(hour.seaTemp) && hour.seaTemp < 10) {
    add({
      level: 'warning',
      code: 'cold-water',
      text: `Sea is ${Math.round(hour.seaTemp)} °C — cold water shock is real. Get your face wet before you commit.`,
    });
  }

  if (regime?.spring && Number.isFinite(scored.hs) && scored.hs > 1.2) {
    add({
      level: 'serious',
      code: 'spring-rips',
      text: `Spring tide (${regime.rangeM.toFixed(1)} m range) with ${scored.hs.toFixed(1)} m swell — expect strong rips and a lot of water moving.`,
    });
  }

  if (craft.id === 'ww-kayak' && Number.isFinite(scored.steepness) && scored.steepness > 0.034 && scored.hs > 1.0) {
    add({
      level: 'serious',
      code: 'dumpy',
      text: 'Short, steep and dumping — a river boat will pearl and backloop on these.',
    });
  }

  for (const hazard of spot.hazards || []) {
    add({ level: 'info', code: `hazard:${hazard}`, text: hazard });
  }

  if (hour.daylight === false) {
    add({ level: 'warning', code: 'dark', text: 'Outside daylight hours.' });
  }

  if (Number.isFinite(hour.precip) && hour.precip >= 2) {
    add({ level: 'info', code: 'rain', text: `Wet — ${hour.precip.toFixed(1)} mm/h.` });
  }

  return out;
}
