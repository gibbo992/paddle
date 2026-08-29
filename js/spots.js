// Break definitions for the Tyne & Wear / south Northumberland coast.
//
// IMPORTANT: `facing`, `swellWindow`, `tide` and `shelter` are informed
// estimates, not surveyed data. They are the knobs that decide whether the app
// agrees with what you actually find when you get there. Tune them — that is
// what this file is for. See README §"Tuning the spots".
//
//   facing       compass bearing the beach looks out along (seaward normal)
//   swellWindow  { from, to }  arc of swell directions that reaches the break,
//                { best0, best1 } the core of that arc
//                (all "direction the swell comes FROM", degrees)
//   shelter      multiplier on open-coast wave height — headlands and piers
//                knock size down inside a bay
//   tide         normalised tide height 0 (low) .. 1 (high)
//                ok0..best0..best1..ok1 trapezoid
//   dirWeight    how sharply an off-window swell kills it (a tight bay cares
//                far more than an open beach)
//   tideWeight   how much the tide matters here

export const SPOTS = [
  {
    id: 'cullercoats',
    name: 'Cullercoats Bay',
    short: 'Cullercoats',
    lat: 55.0335,
    lon: -1.4322,
    home: true,
    facing: 70,
    swellWindow: { from: 15, to: 120, best0: 45, best1: 90 },
    shelter: 0.82,
    tide: { ok0: 0.25, best0: 0.5, best1: 0.9, ok1: 1.0 },
    dirWeight: 2.0,
    tideWeight: 1.3,
    notes: 'Small bay held between two piers. Needs a NE–E swell to get in, and ' +
      'fills in from mid tide up. Sheltered from S and SW wind by the village.',
  },
  {
    id: 'longsands',
    name: 'Tynemouth Longsands',
    short: 'Longsands',
    lat: 55.0230,
    lon: -1.4200,
    facing: 80,
    swellWindow: { from: 340, to: 130, best0: 30, best1: 95 },
    shelter: 1.0,
    tide: { ok0: 0.0, best0: 0.15, best1: 0.65, ok1: 0.95 },
    dirWeight: 1.1,
    tideWeight: 0.9,
    notes: 'The open beach — picks up most swell going and works through most of ' +
      'the tide. Best banks tend to be low to mid. Crowded when it is on.',
  },
  {
    id: 'kingedwards',
    name: "King Edward's Bay",
    short: "King Edward's",
    lat: 55.0180,
    lon: -1.4180,
    facing: 75,
    swellWindow: { from: 30, to: 105, best0: 50, best1: 85 },
    shelter: 0.68,
    tide: { ok0: 0.15, best0: 0.3, best1: 0.7, ok1: 0.9 },
    dirWeight: 2.2,
    tideWeight: 1.4,
    notes: 'Tucked under the priory. Very sheltered, so it needs a solid NE–E ' +
      'swell before anything shows. Shrinks to nothing at high water.',
  },
  {
    id: 'whitley',
    name: 'Whitley Bay',
    short: 'Whitley',
    lat: 55.0480,
    lon: -1.4420,
    facing: 85,
    swellWindow: { from: 350, to: 125, best0: 40, best1: 100 },
    shelter: 0.95,
    tide: { ok0: 0.2, best0: 0.4, best1: 0.85, ok1: 1.0 },
    dirWeight: 1.2,
    tideWeight: 1.0,
    notes: 'Long open sands north of St Mary’s. Similar swell window to Longsands ' +
      'but prefers more water on it.',
  },
  {
    id: 'seaton-sluice',
    name: 'Seaton Sluice',
    short: 'Seaton Sluice',
    lat: 55.0840,
    lon: -1.4740,
    facing: 80,
    swellWindow: { from: 350, to: 130, best0: 40, best1: 100 },
    shelter: 0.93,
    tide: { ok0: 0.05, best0: 0.2, best1: 0.7, ok1: 0.95 },
    dirWeight: 1.2,
    tideWeight: 1.0,
    notes: 'Beach and harbour mouth between Whitley and Blyth. Collywell Bay end is ' +
      'sheltered and small; the open sand to the south takes more swell. Works ' +
      'best with the tide off the top.',
  },
  {
    id: 'blyth',
    name: 'Blyth South Beach',
    short: 'Blyth',
    lat: 55.1180,
    lon: -1.5030,
    facing: 95,
    swellWindow: { from: 350, to: 140, best0: 45, best1: 110 },
    shelter: 1.0,
    tide: { ok0: 0.0, best0: 0.1, best1: 0.6, ok1: 0.9 },
    dirWeight: 1.1,
    tideWeight: 0.9,
    notes: 'Open, exposed and usually a touch bigger than the Tynemouth beaches. ' +
      'The pier end holds shape in more wind.',
  },
];

export const SPOTS_BY_ID = Object.fromEntries(SPOTS.map((s) => [s.id, s]));

export const DEFAULT_SPOT_ID = 'cullercoats';

export function getSpot(id) {
  return SPOTS_BY_ID[id] || SPOTS_BY_ID[DEFAULT_SPOT_ID];
}
