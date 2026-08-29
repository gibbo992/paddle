// The whitewater tab: RiverPredictor, embedded.
//
// A cross-origin frame gives you no usable signal about whether it actually
// rendered. `load` fires even when the browser refuses the frame over
// X-Frame-Options or a CSP `frame-ancestors` rule, and reading into the frame
// throws either way. So there is no honest way to detect a refusal and swap in
// a fallback — which is why the escape hatch here is permanent rather than
// conditional: an always-visible Open button and a line of text saying what to
// do if the panel is blank.

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
export function renderRivers({ url, frame, hostEl, hintEl, openBtn }) {
  const parsed = safeUrl(url);

  if (!parsed) {
    frame.replaceChildren();
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'That RiverPredictor address doesn’t look like a valid URL. Check it in Settings.';
    frame.append(p);
    hostEl.textContent = String(url || '');
    hintEl.textContent = '';
    return;
  }

  hostEl.textContent = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);

  openBtn.onclick = () => window.open(parsed.href, '_blank', 'noopener,noreferrer');

  hintEl.replaceChildren();
  hintEl.append(document.createTextNode('Blank or refusing to load? Some sites block being embedded — '));
  const a = document.createElement('a');
  a.href = parsed.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'open it directly';
  hintEl.append(a, document.createTextNode('.'));

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
 * The river panels are fixed rather than flowed, because the header changes
 * height when the craft control hides. Measure the real chrome and hand the
 * numbers to CSS.
 */
export function measureRivers() {
  const set = (name, el, fallback) => {
    const h = el ? Math.round(el.getBoundingClientRect().height) : fallback;
    document.documentElement.style.setProperty(name, `${h || fallback}px`);
  };
  set('--header-h', document.querySelector('.topbar'), 56);
  set('--nav-h', document.querySelector('.nav'), 60);
  set('--riverbar-h', document.querySelector('.riverbar'), 51);
  set('--riverhint-h', document.querySelector('.riverhint'), 34);
}
