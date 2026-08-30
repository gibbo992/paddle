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
    swellWindow: { from: 330, to: 130, best0: 0, best1: 80 },
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
    facing: 90,
    swellWindow: { from: 350, to: 100, best0: 5, best1: 60 },
    shelter: 0.68,
    tide: { ok0: 0.0, best0: 0.05, best1: 0.45, ok1: 0.75 },
    prefersPush: false,
    dirWeight: 2.2,
    tideWeight: 1.4,
    hazards: ['Cliffs and rocks on both sides', 'Shrinks to almost nothing at high water',
      'Poor water quality'],
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
    // NNE swell, SW offshore (225°), works across the tide. The most
    // consistent beach of the group — a broad bay that picks up more swell
    // than its neighbours and breaks over several banks.
    facing: 45,
    swellWindow: { from: 325, to: 120, best0: 345, best1: 70 },
    shelter: 0.98,
    tide: { ok0: 0.0, best0: 0.15, best1: 0.9, ok1: 1.0 },
    prefersPush: false,
    dirWeight: 1.2,
    tideWeight: 0.7,
    hazards: ['Rock in among the sand', 'Gets busy when it is on'],
    notes: 'The most consistent beach of the six — a broad bay that picks up more ' +
      'swell than its neighbours and breaks left and right across several banks. ' +
      'Works across the tide. Popular for the same reasons, and there is rock in ' +
      'among the sand to keep track of.',
  },
  {
    id: 'hartley-reef',
    name: 'Hartley Reef',
    short: 'Hartley',
    lat: 55.0700,
    lon: -1.4620,
    confidence: 'sourced',
    reef: true,
    // The only reef on this stretch, and the best wave on it. NNE swell but
    // takes anything from N through E; W offshore, tolerating NW–SW. Mid to
    // high water, on the push. Flat rock shelf, breaks both ways.
    facing: 90,
    swellWindow: { from: 330, to: 130, best0: 345, best1: 100 },
    // Above 1: a reef focuses swell rather than sheltering from it, which is
    // why it starts working under a metre when the beaches are still flat.
    shelter: 1.12,
    tide: { ok0: 0.2, best0: 0.5, best1: 0.95, ok1: 1.0 },
    prefersPush: true,
    dirWeight: 1.3,
    tideWeight: 1.3,
    hazards: [
      'Flat rock shelf close under the surface',
      'Rips running off the reef',
      'Poor water quality',
    ],
    notes: 'The best wave on this stretch and the one that asks the most. Flat rock ' +
      'bottom, breaks both ways, starts working under a metre and holds past four — ' +
      'so it is the call when the beaches are too small, and equally when they are ' +
      'too big. Experienced paddlers only: a reef is unforgiving in a boat.',
  },
  {
    id: 'seaton-sluice',
    name: 'Seaton Sluice',
    short: 'Seaton Sluice',
    lat: 55.0840,
    lon: -1.4740,
    confidence: 'sourced',
    // Guide: ideal swell NNE, offshore SSW, best around MID tide.
    facing: 23,
    swellWindow: { from: 325, to: 115, best0: 345, best1: 70 },
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
    facing: 113,
    swellWindow: { from: 320, to: 135, best0: 345, best1: 70 },
    shelter: 1.0,
    tide: { ok0: 0.25, best0: 0.6, best1: 1.0, ok1: 1.0 },
    prefersPush: true,
    dirWeight: 1.0,
    tideWeight: 1.1,
    hazards: ['Rip along the pier', 'Shipping in and out of the harbour',
      'Poor water quality — try not to swallow it'],
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
