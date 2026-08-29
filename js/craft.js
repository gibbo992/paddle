// Craft profiles — the whole point of this app.
//
// Surfline scores for a shortboard. A shortboard needs a steep, powerful,
// reasonably long-period wave before it will go at all, so it writes off a lot
// of days that are perfectly good in a boat. The differences that matter:
//
//  * A surf kayak planes and is already moving. It catches waves far earlier
//    than a board, so it works in small, weak, gutless surf a board sinks in.
//  * A surf kayak is long and low-volume in the nose — it will pearl and it is
//    much harder to get out through a big dumping shorebreak (no duck dive).
//    So its top end is lower than a board's, not higher.
//  * A whitewater boat does not plane. It needs a steeper, punchier wave to get
//    going, gives short rides, and is happiest in small-to-middling spilling
//    surf. It tolerates short-period slop better than anything else, and is the
//    most forgiving thing to be sat in — but it backloops and pins in real size,
//    so its ceiling is lower again.
//  * Every kayak is a big windage brick compared with a board. Strong wind of
//    any direction is a bigger deal, and strong offshore is a safety issue as
//    much as a quality one.
//
// Height bands below are on *significant wave height* (Hs) in metres as the
// model reports it, after the spot's shelter factor. Breaking face height is
// roughly 1.4× that and is what the UI displays.

export const CRAFT = [
  {
    id: 'surf-kayak',
    name: 'Surf kayak',
    short: 'Surf kayak',
    icon: '🛶',
    blurb: 'Planing surf kayak or waveski',
    // Catches early → low minimum. Hard to escape a big beating → modest ceiling.
    size: { a: 0.22, b: 0.6, c: 1.6, d: 2.7 },
    hardMax: 2.4,
    // Happy from short-period windswell upward.
    period: { a: 3.0, b: 5.5, c: 14, d: 20 },
    // Hs / deep-water wavelength. Likes a little steepness for the drop.
    steepness: { a: 0.0025, b: 0.006, c: 0.026, d: 0.042 },
    onshoreTolerance: 1.25,   // >1 = copes with more onshore slop than a board
    offshoreTolerance: 0.85,  // <1 = strong offshore hurts sooner than a board
    crossTolerance: 0.9,
    tooBigMsg: 'Over the size a surf kayak is any fun — getting out will be the whole session.',
    tooSmallMsg: 'Not enough to plane on, even in a surf kayak.',
  },
  {
    id: 'ww-kayak',
    name: 'Whitewater kayak',
    short: 'Whitewater',
    icon: '🚣',
    blurb: 'River boat, creeker or playboat',
    size: { a: 0.18, b: 0.45, c: 1.15, d: 1.9 },
    hardMax: 1.6,
    // Copes with the shortest, sloppiest windswell of the three.
    period: { a: 2.5, b: 4.5, c: 11, d: 16 },
    // Needs more steepness than a planing hull to get picked up at all.
    steepness: { a: 0.004, b: 0.010, c: 0.032, d: 0.050 },
    onshoreTolerance: 1.4,
    offshoreTolerance: 0.8,
    crossTolerance: 0.85,
    tooBigMsg: 'Too big and too dumpy for a river boat — backloop and pinning territory.',
    tooSmallMsg: 'Nothing steep enough to pick a river boat up.',
  },
  {
    id: 'board',
    name: 'Shortboard',
    short: 'Board',
    icon: '🏄',
    blurb: 'Reference — roughly what Surfline is scoring',
    size: { a: 0.5, b: 1.0, c: 2.2, d: 3.6 },
    hardMax: 3.2,
    period: { a: 4.5, b: 8, c: 16, d: 22 },
    steepness: { a: 0.0018, b: 0.005, c: 0.019, d: 0.033 },
    onshoreTolerance: 1.0,
    offshoreTolerance: 1.0,
    crossTolerance: 1.0,
    tooBigMsg: 'Beyond an average session — big-wave gear and a lot of confidence.',
    tooSmallMsg: 'Flat. Nothing to stand up on.',
  },
];

export const CRAFT_BY_ID = Object.fromEntries(CRAFT.map((c) => [c.id, c]));

export const DEFAULT_CRAFT_ID = 'surf-kayak';

export function getCraft(id) {
  return CRAFT_BY_ID[id] || CRAFT_BY_ID[DEFAULT_CRAFT_ID];
}
