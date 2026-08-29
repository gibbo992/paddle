// Break definitions for the Tyne & Wear / south Northumberland coast.
//
// PROVENANCE MATTERS HERE. Each spot below is marked `sourced` or `estimated`:
//
//   sourced   — swell/wind/tide preferences taken from published break guides
//               (surf-forecast.com break pages, Surfline spot guides). Those
//               guides describe what a BOARD wants. The craft profiles in
//               craft.js then re-score it for a boat; the spot's swell window,
//               shelter and tide preference are properties of the beach and
//               apply whatever you are paddling.
//   estimated — my best guess. Cullercoats in particular is not listed as a
//               break by the forecast sites at all, because at 0–1 ft it is
//               beneath a shortboard's notice. That is exactly the gap this
//               app exists to fill, but it does mean nobody has published
//               numbers for it.
//
// `facing` is set from the REPORTED OFFSHORE WIND rather than from the
// geometry of the beach, because that is the job it does in the model: it
// defines which way the wind has to blow to be groomed. In a bay sheltered by
// a headland the best wind is not always square to the sand, so deriving it
// from the guide is more accurate than deriving it from a map.
//
//   facing       bearing the wind must come FROM, minus 180 — i.e. offshore
//                is `facing + 180`
//   swellWindow  { from, to }  arc of swell directions that reaches the break,
//                { best0, best1 } the core of that arc
//                (all "direction the swell comes FROM", degrees)
//   shelter      multiplier on open-coast wave height
//   tide         normalised tide height 0 (low) .. 1 (high)
//   prefersPush  true where the guides say a rising tide is better
//   hazards      surfaced in the app, so local nasties aren't a surprise
//
// Tune them. See README §"Tuning the spots".

export const SPOTS = [
  {
    id: 'cullercoats',
    name: 'Cullercoats Bay',
    short: 'Cullercoats',
    lat: 55.0335,
    lon: -1.4322,
    home: true,
    confidence: 'estimated',
    facing: 70,
    swellWindow: { from: 10, to: 110, best0: 30, best1: 80 },
    shelter: 0.78,
    tide: { ok0: 0.2, best0: 0.45, best1: 0.85, ok1: 1.0 },
    prefersPush: false,
    dirWeight: 2.0,
    tideWeight: 1.3,
    hazards: ['Piers and rocks at both ends of the bay'],
    notes: 'Semi-circular bay held between two stone piers — properly sheltered, ' +
      'and usually knee-high when the open beaches are chest-high. Not listed as ' +
      'a break by the forecast sites, which is the point: too small for a board, ' +
      'often fine in a boat. Swell window and tide here are estimates.',
  },
  {
    id: 'longsands',
    name: 'Tynemouth Longsands',
    short: 'Longsands',
    lat: 55.0230,
    lon: -1.4200,
    confidence: 'sourced',
    // Guide: ideal swell NE, offshore WSW (247°), works at all stages of tide
    // with the two decent banks best "on the tidal push".
    facing: 68,
    swellWindow: { from: 340, to: 130, best0: 25, best1: 70 },
    shelter: 1.0,
    tide: { ok0: 0.0, best0: 0.12, best1: 0.9, ok1: 1.0 },
    prefersPush: true,
    dirWeight: 1.1,
    tideWeight: 0.7,
    hazards: [],
    notes: 'The open beach and the most consistent of them. Takes NE swell with a ' +
      'WSW offshore. Works at all stages of the tide — the left towards the pool ' +
      'and the right at the north end come in on the push. Busiest when it is on.',
  },
  {
    id: 'kingedwards',
    name: "King Edward's Bay",
    short: "King Edward's",
    lat: 55.0180,
    lon: -1.4180,
    confidence: 'sourced',
    // Guide: NE-facing cove sheltered by cliffs, ideal swell NNE, offshore W,
    // best around LOW tide.
    facing: 80,
    swellWindow: { from: 350, to: 100, best0: 10, best1: 55 },
    shelter: 0.68,
    tide: { ok0: 0.0, best0: 0.05, best1: 0.45, ok1: 0.75 },
    prefersPush: false,
    dirWeight: 2.2,
    tideWeight: 1.4,
    hazards: ['Cliffs and rocks on both sides', 'Shrinks to almost nothing at high water'],
    notes: 'Cove under the priory, sheltered by cliffs on both sides. Wants a NNE ' +
      'swell and a W offshore, and it is best around low water — the beach all ' +
      'but disappears at the top of the tide. Needs a solid swell before anything shows.',
  },
  {
    id: 'whitley',
    name: 'Whitley Bay',
    short: 'Whitley',
    lat: 55.0480,
    lon: -1.4420,
    confidence: 'sourced',
    // Guide: ideal swell NNE, offshore SW, rocks a hazard, inconsistent.
    // No tide preference published — that part is an estimate.
    facing: 55,
    swellWindow: { from: 345, to: 120, best0: 10, best1: 60 },
    shelter: 0.95,
    tide: { ok0: 0.15, best0: 0.35, best1: 0.75, ok1: 1.0 },
    prefersPush: false,
    dirWeight: 1.2,
    tideWeight: 0.9,
    hazards: ['Rocks — a stated hazard here'],
    notes: 'Long open sands. NNE swell with a SW offshore is the combination. ' +
      'Inconsistent, and there are rocks about. No published tide preference, ' +
      'so the tide band here is a guess.',
  },
  {
    id: 'seaton-sluice',
    name: 'Seaton Sluice',
    short: 'Seaton Sluice',
    lat: 55.0840,
    lon: -1.4740,
    confidence: 'sourced',
    // Guide: ideal swell NNE, offshore SSW, best around MID tide.
    facing: 45,
    swellWindow: { from: 345, to: 125, best0: 10, best1: 60 },
    shelter: 0.93,
    tide: { ok0: 0.1, best0: 0.3, best1: 0.7, ok1: 0.95 },
    prefersPush: false,
    dirWeight: 1.2,
    tideWeight: 1.1,
    hazards: ['Harbour mouth and rocks at the Collywell Bay end'],
    notes: 'Reasonably exposed beach break between Whitley and Blyth. NNE swell, ' +
      'SSW offshore, best around mid tide. Inconsistent — small far more often ' +
      'than not, which suits a boat better than a board.',
  },
  {
    id: 'blyth',
    name: 'Blyth South Beach',
    short: 'Blyth',
    lat: 55.1180,
    lon: -1.5030,
    confidence: 'sourced',
    // Guide: ideal swell NNE, takes N through ENE round to SE, offshore W/WNW,
    // best around HIGH tide with a rising tide generally better.
    facing: 100,
    swellWindow: { from: 350, to: 140, best0: 15, best1: 65 },
    shelter: 1.0,
    tide: { ok0: 0.25, best0: 0.6, best1: 1.0, ok1: 1.0 },
    prefersPush: true,
    dirWeight: 1.0,
    tideWeight: 1.1,
    hazards: ['Rip along the pier', 'Shipping in and out of the harbour'],
    notes: 'The widest swell window on this stretch — takes anything from N round ' +
      'to SE — and usually a touch bigger than the Tynemouth beaches. Best near ' +
      'high water and better still on a rising tide. W or WNW is the offshore.',
  },
];

export const SPOTS_BY_ID = Object.fromEntries(SPOTS.map((s) => [s.id, s]));

export const DEFAULT_SPOT_ID = 'cullercoats';

export function getSpot(id) {
  return SPOTS_BY_ID[id] || SPOTS_BY_ID[DEFAULT_SPOT_ID];
}
