// What you actually found, against what the app said you would.
//
// The weakest part of this app is not the code, it is the spot table: the
// swell windows, shelter factors and tide bands are published estimates at
// best and outright guesses at Cullercoats. No amount of care in the scoring
// fixes a wrong shelter factor.
//
// So: log what you found. After a handful of sessions the app can tell you
// that Cullercoats reads a point and a half high, and exactly what to change
// to fix it. That is real evidence about your beaches, which nothing else here
// can give you.

const KEY = 'ksc:sessions:v1';

/** The rating words, as a score, so a tap can be compared with a prediction. */
export const ACTUAL_OPTIONS = [
  { label: 'Excellent', score: 9.1 },
  { label: 'Good', score: 7.7 },
  { label: 'Fair', score: 6.2 },
  { label: 'Marginal', score: 4.7 },
  { label: 'Poor', score: 3.0 },
  { label: 'Flat', score: 1.0 },
];

export function loadSessions() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValid) : [];
  } catch {
    return [];
  }
}

function isValid(s) {
  return s && typeof s.spotId === 'string'
    && Number.isFinite(s.predicted) && Number.isFinite(s.actual);
}

function save(sessions) {
  try {
    // Keep it bounded — this is a tuning aid, not a diary.
    localStorage.setItem(KEY, JSON.stringify(sessions.slice(-200)));
  } catch { /* private mode; logging is a nicety */ }
  return sessions;
}

export function addSession({ spotId, craftId, predicted, actual, at = Date.now() }) {
  const sessions = loadSessions();
  sessions.push({ id: `${at}-${spotId}`, at, spotId, craftId, predicted, actual });
  return save(sessions);
}

export function removeSession(id) {
  return save(loadSessions().filter((s) => s.id !== id));
}

export function clearSessions() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return [];
}

/**
 * How far out the app has been at one spot.
 *
 * Positive bias means it scored LOWER than you found — the app is pessimistic.
 * Negative means it over-promised, which is the failure that wastes a drive.
 */
export function biasFor(spotId, sessions = loadSessions()) {
  const mine = sessions.filter((s) => s.spotId === spotId);
  if (!mine.length) return { count: 0, bias: NaN, mae: NaN };

  const diffs = mine.map((s) => s.actual - s.predicted);
  const bias = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const mae = diffs.reduce((a, b) => a + Math.abs(b), 0) / diffs.length;
  return { count: mine.length, bias, mae };
}

/** Enough sessions to say anything at all. Below this it is noise. */
export const MIN_SESSIONS = 3;

/**
 * Plain advice, or null when there is nothing worth saying yet.
 * Names the parameter to change and which way, because "it reads high" on its
 * own does not tell you what to do about it.
 */
export function tuningAdvice(spot, sessions = loadSessions()) {
  const { count, bias, mae } = biasFor(spot.id, sessions);
  if (count < MIN_SESSIONS) {
    return {
      count,
      text: `${count} of ${MIN_SESSIONS} sessions logged. A few more and this can tell you how far out ${spot.short} reads.`,
    };
  }

  if (Math.abs(bias) < 0.8) {
    return { count, bias, mae, text: `${spot.short} is reading about right over ${count} sessions.` };
  }

  const high = bias < 0;
  // Shelter multiplies the wave height reaching the break, so it is the honest
  // dial for "there is consistently less/more here than the app thinks".
  const suggested = (spot.shelter * (1 + bias * 0.06)).toFixed(2);
  return {
    count,
    bias,
    mae,
    text: `Over ${count} sessions ${spot.short} reads about ${Math.abs(bias).toFixed(1)} `
      + `${high ? 'too high' : 'too low'}. Try changing its shelter from `
      + `${spot.shelter} to ${suggested} in js/spots.js.`,
  };
}
