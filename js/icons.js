// Inline SVG icons. Emoji were doing this job and rendering inconsistently —
// the calendar in particular came out as a "July 17" glyph, which is both noisy
// and wrong. These are stroke icons on a 24-grid, sized by CSS.

const svg = (paths, opts = {}) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${opts.w || 1.7}" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  // Craft ------------------------------------------------------------------
  // A planing surf kayak: fine ends, flat rocker.
  'surf-kayak': svg('<path d="M2.5 12c3-2.6 6.3-3.9 9.5-3.9S18.5 9.4 21.5 12c-3 2.6-6.3 3.9-9.5 3.9S5.5 14.6 2.5 12Z"/><path d="M8.6 9.2 15.4 14.8"/>'),
  // A river boat: shorter, fuller, more rocker.
  'ww-kayak': svg('<path d="M3.5 10.5c2.8 3 5.6 4.5 8.5 4.5s5.7-1.5 8.5-4.5"/><path d="M3.5 10.5C6.3 8.9 9.1 8.1 12 8.1s5.7.8 8.5 2.4"/><path d="M12 8.1v6.9"/>'),
  // A board with a fin.
  board: svg('<path d="M12 2.5c3.4 3.4 5.2 7.1 5.2 10.4 0 3.9-2.1 6.9-5.2 8.6-3.1-1.7-5.2-4.7-5.2-8.6 0-3.3 1.8-7 5.2-10.4Z"/><path d="M12 13v8.5"/>'),

  // Navigation -------------------------------------------------------------
  wave: svg('<path d="M2 15.5c2 0 2.5-2 5-2s3 2 5 2 2.5-2 5-2 3 2 5 2"/><path d="M2 10c2 0 2.5-2 5-2s3 2 5 2 2.5-2 5-2 3 2 5 2"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  chart: svg('<path d="M3 20h18"/><path d="M6 20v-6M10.5 20V8M15 20v-9M19.5 20V5"/>'),

  // Chrome -----------------------------------------------------------------
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/>', { w: 1.4 }),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  arrowRight: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),

  // Status — always paired with a label, never colour alone.
  critical: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3h.01"/>'),
  serious: svg('<path d="M10.3 3.9 2.4 17.4A2 2 0 0 0 4.1 20.4h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 16.5h.01"/>'),
  warning: svg('<path d="M10.3 3.9 2.4 17.4A2 2 0 0 0 4.1 20.4h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 16.5h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/>'),
  good: svg('<circle cx="12" cy="12" r="9"/><path d="m8.2 12.2 2.6 2.6 5-5.4"/>'),

  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', { w: 1.5 }),
  offline: svg('<path d="M3 3l18 18"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 13a10 10 0 0 1 3.2-2.2M19 13a10 10 0 0 0-6.4-2.9"/><path d="M2 9.2A15 15 0 0 1 6 6.7M22 9.2a15 15 0 0 0-9.5-3.6"/><path d="M12 20h.01"/>', { w: 1.5 }),
  flask: svg('<path d="M9 3h6M10.5 3v6.5L5.2 18a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3l-5.3-8.5V3"/><path d="M7.5 15h9"/>'),
  hand: svg('<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6.5 6.5 0 0 1-6.5-6.5V13a1.5 1.5 0 0 1 3 0"/>'),
  shrug: svg('<circle cx="12" cy="8" r="3.2"/><path d="M4 20c0-3.6 3.6-6.5 8-6.5s8 2.9 8 6.5"/>'),
};

/** Set an element's contents to an icon. */
export function icon(name) {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = ICONS[name] || ICONS.info;
  return span.firstElementChild;
}

export function iconHtml(name) {
  return ICONS[name] || ICONS.info;
}
