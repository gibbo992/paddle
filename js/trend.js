// Is it building or dropping?
//
// "1.2 m" means two different things depending on which way it is going. A
// swell filling in through the afternoon is worth waiting for; the same height
// on the back of a fading one means you have missed it.

/** Annotate each hour with where the swell is heading over the next six hours. */
export function annotateTrend(hours) {
  const n = hours.length;
  for (let i = 0; i < n; i++) {
    const ahead = hours[Math.min(n - 1, i + 6)].waveHeight;
    const now = hours[i].waveHeight;

    if (!Number.isFinite(now) || !Number.isFinite(ahead)) {
      hours[i].trend = 'unknown';
      hours[i].trendDelta = NaN;
      continue;
    }

    // Relative, with a floor: 20 cm of change on a 30 cm sea is a doubling,
    // the same 20 cm on 2 m is nothing.
    const delta = (ahead - now) / Math.max(0.35, now);
    hours[i].trendDelta = delta;
    hours[i].trend = delta > 0.18 ? 'building' : delta < -0.18 ? 'easing' : 'holding';
  }
  return hours;
}

const WORDS = {
  building: 'building',
  easing: 'easing',
  holding: 'holding',
  unknown: '',
};

export const trendWord = (t) => WORDS[t] ?? '';

/** An arrow for the stat line. Paired with the word, never used alone. */
export const trendArrow = (t) => (t === 'building' ? '↑' : t === 'easing' ? '↓' : t === 'holding' ? '→' : '');
