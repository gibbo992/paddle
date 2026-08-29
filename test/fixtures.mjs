// Synthetic but realistic hourly records, so the scoring can be exercised
// without reaching the network.

export function hour(overrides = {}) {
  return {
    time: new Date(2026, 8, 1, 7, 0),
    waveHeight: 1.0,
    waveDirection: 65,
    wavePeriod: 8,
    swellHeight: 0.9,
    swellDirection: 65,
    swellPeriod: 8,
    seaTemp: 14,
    seaLevel: 1.2,
    airTemp: 13,
    apparentTemp: 11,
    precip: 0,
    windKn: 6,
    windGustKn: 9,
    windDirection: 245,   // offshore for a ~070° facing beach
    tideNorm: 0.7,
    tideState: 'rising',
    daylight: true,
    ...overrides,
  };
}

/** A full synthetic forecast for window-finding tests. */
export function makeForecast(spotId, { days = 3, from = new Date(2026, 8, 1, 0, 0), hourFn } = {}) {
  const hours = [];
  for (let i = 0; i < days * 24; i++) {
    const time = new Date(+from + i * 3600e3);
    const base = hour({ time, seaLevel: 2.2 * Math.sin((2 * Math.PI * i) / 12.42) });
    hours.push(hourFn ? hourFn(base, i) : base);
  }
  hours.forEach((h, i) => {
    h.tideNorm = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / 12.42);
    h.tideState = Math.cos((2 * Math.PI * i) / 12.42) > 0 ? 'rising' : 'falling';
  });

  const daily = new Map();
  for (let d = 0; d < days; d++) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, 12, 0);
    const sunrise = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, 5, 40);
    const sunset = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, 19, 50);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    daily.set(key, {
      date, sunrise, sunset,
      lightFrom: new Date(+sunrise - 25 * 60000),
      lightTo: new Date(+sunset + 25 * 60000),
    });
  }

  return { spotId, fetchedAt: Date.now(), hours, daily, tideEvents: [], units: {} };
}
