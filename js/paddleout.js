// Getting out.
//
// Every surf forecast scores the wave. For a kayak the hard part is often the
// paddle out: no duck dive, four metres of boat to get through a broken wall,
// and set waves arriving on a schedule you cannot see from a wave height. A
// 1.5 m day at 12 s with long lulls is a pleasant paddle out. The same height
// at 6 s is half an hour of getting hammered, and the wave height alone cannot
// tell you which one you are looking at.
//
// The model is deliberately crude — beach slope, bank shape and rips all
// matter and none of them are in the data — but the ranking it produces is
// the useful part, and it is built from things the forecast does know.

import { clamp } from './util.js';

/**
 * How far out the surf zone reaches, in metres.
 *
 * Waves break in roughly 1.3× their height of water, so bigger swell breaks
 * further out; on a shallow-sloping sand beach that distance grows fast. The
 * constants are fitted to a North East beach, not derived — a metre of swell
 * putting the break about 85 m out is about right for Longsands.
 */
export function surfZoneWidth(hs) {
  if (!Number.isFinite(hs) || hs <= 0) return 0;
  return 25 + 60 * hs;
}

/**
 * Effort to get outside, as a dimensionless number.
 *
 * Three things multiply together: how long you are in the impact zone, how
 * often a wave arrives while you are there, and how much each one costs.
 */
export function paddleOutEffort({ hs, period, craft }) {
  if (!Number.isFinite(hs) || hs <= 0.15) return 0;

  const width = surfZoneWidth(hs);
  const seconds = width / (craft.paddleSpeed || 1.5);

  // Wave interval. Short-period windswell gives you no gaps at all; a long
  // groundswell arrives in sets with real lulls between them.
  const interval = Math.max(4, Number.isFinite(period) ? period : 7);
  const waves = seconds / interval;

  // Cost per wave rises faster than linearly — twice the height is much more
  // than twice the problem once it is breaking on your deck.
  const perWave = (hs / (craft.punchThrough || 1.5)) ** 1.5;

  return waves * perWave;
}

const BANDS = [
  { max: 1.5, label: 'Easy', tone: 'good', note: 'Straightforward paddle out.' },
  { max: 4, label: 'Manageable', tone: 'good', note: 'A few walls to get through, nothing serious.' },
  { max: 8, label: 'Hard work', tone: 'warning', note: 'Expect to work for it — pick your gap and commit.' },
  { max: 14, label: 'Serious', tone: 'serious', note: 'Long spells in the impact zone. Not one to do tired or alone.' },
  { max: Infinity, label: 'Brutal', tone: 'critical', note: 'Getting out will be the whole session.' },
];

/**
 * Getting out, split into what the sea is doing and what it costs THIS craft.
 *
 * `widthM` and `intervalS` are properties of the beach and the swell, so they
 * are the same whichever boat you are in. `waves` is not: it is how many reach
 * you while you are crossing, which depends on how fast you cross. Presenting
 * the two side by side without saying so made the wave count look like it was
 * disagreeing with itself between craft.
 *
 * @returns {{effort:number, label:string, tone:string, note:string,
 *            widthM:number, intervalS:number, waves:number, secondsOut:number}}
 */
export function paddleOut({ hs, period, craft }) {
  const effort = paddleOutEffort({ hs, period, craft });
  const band = BANDS.find((b) => effort < b.max) || BANDS[BANDS.length - 1];
  const widthM = surfZoneWidth(hs);
  const interval = Math.max(4, Number.isFinite(period) ? period : 7);

  const secondsOut = widthM / (craft.paddleSpeed || 1.5);

  return {
    effort,
    label: band.label,
    tone: band.tone,
    note: band.note,
    // Shared: the beach and the swell.
    widthM: Math.round(widthM),
    intervalS: Math.round(interval),
    // Craft-specific: how long you are out there, and what reaches you.
    secondsOut: Math.round(secondsOut),
    waves: Math.max(effort > 0 ? 1 : 0, Math.round(secondsOut / interval)),
  };
}

/** 0..1, where 1 is an easy paddle out. For anything that wants a fraction. */
export function paddleOutEase(effort) {
  if (!Number.isFinite(effort)) return NaN;
  return clamp(1 - effort / 16, 0, 1);
}
