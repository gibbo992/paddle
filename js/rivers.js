// The whitewater tab: RiverPredictor, embedded full screen.
//
// The site frames without complaint, so the tab is just the page. The only
// chrome is a small floating button out to a real browser tab — worth keeping
// because a framed page has no address bar, no back button and no way to share
// a link, not because the embed is expected to fail.

let currentUrl = null;

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    // Only ever frame or open http(s) — never javascript: or data:.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Mount the embed. The iframe is created on first visit rather than at boot so
 * opening the app for the surf forecast doesn't pull down a third-party page.
 */
export function renderRivers({ url, frame, openBtn }) {
  const parsed = safeUrl(url);

  if (!parsed) {
    frame.replaceChildren();
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'That RiverPredictor address doesn’t look like a valid URL. Check it in Settings.';
    frame.append(p);
    openBtn.hidden = true;
    return;
  }

  openBtn.hidden = false;
  openBtn.onclick = () => window.open(parsed.href, '_blank', 'noopener,noreferrer');

  // Rebuild only when the address actually changes — otherwise switching tabs
  // would reload the page and lose whatever you had scrolled to.
  if (currentUrl === parsed.href && frame.querySelector('iframe')) return;
  currentUrl = parsed.href;

  const iframe = document.createElement('iframe');
  iframe.src = parsed.href;
  iframe.title = 'RiverPredictor';
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.setAttribute('allow', 'geolocation');
  frame.replaceChildren(iframe);
}

/**
 * The frame is fixed rather than flowed, because the header changes height
 * when the craft control hides. Measure the real chrome and hand CSS the
 * numbers.
 */
export function measureRivers() {
  const set = (name, el, fallback) => {
    const h = el ? Math.round(el.getBoundingClientRect().height) : fallback;
    document.documentElement.style.setProperty(name, `${h || fallback}px`);
  };
  set('--header-h', document.querySelector('.topbar'), 56);
  set('--nav-h', document.querySelector('.nav'), 60);
}
