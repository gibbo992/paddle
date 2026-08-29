# Kayak Surf — Cullercoats

Surf conditions for the Tyne & Wear coast, scored for a **surf kayak** or a
**whitewater kayak** instead of a shortboard.

Surfline and the rest score for a board. A shortboard needs a steep, powerful,
reasonably long-period wave before it will go at all, so it writes off a lot of
mornings that are perfectly good in a boat — and it is relaxed about size that
is genuinely unpleasant in a kayak. This app scores the same forecast against
what a kayak actually needs.

Installable on a phone (Add to Home Screen), works offline on last-known data,
no account, no server, no API key.

---

## What it tells you

- **A score out of 10** for the craft you picked, at the spot you picked, right now.
- **Best sessions** — the next week ranked across every beach you have switched
  on, restricted to the hours you can actually paddle (before work, after work,
  weekends), clipped to daylight, and optionally filtered against your Google
  Calendar.
- **What's holding it back** — the weakest component, so you know whether it's
  the tide, the wind, or just too small.
- **Surf height** (breaking face and swell), **period**, **swell direction**,
  **wind** resolved against the beach, **tide** state with high/low times,
  **air and sea temperature**.
- **What to wear** — drysuit through to shorty, adjusted for wind chill.
- **Safety flags** — strong offshore, spring-tide rips, cold water shock,
  surf too big or too dumpy for the boat.

## Why a kayak scores differently

| | Surf kayak | Whitewater kayak | Shortboard |
|---|---|---|---|
| Smallest usable | ~0.2 m Hs — it planes, so it catches waves early | ~0.2 m, but it needs steepness to get going | ~0.5 m |
| Ideal | 0.6–1.6 m | 0.45–1.15 m | 1.0–2.2 m |
| Ceiling | 2.4 m — no duck dive, so getting out is the whole session | 1.6 m — it backloops and pins | 3.2 m |
| Short-period slop | Fine | Best of the three | Poor |
| Wind | Worse than a board: a boat is a big windage brick, and strong offshore is a safety problem, not just a quality one | | |

## Running it

It's plain static files — no build step, no dependencies at runtime.

```bash
npm run serve      # http://localhost:8080
npm test           # 49 tests over the scoring, tides and window finding
```

Append `?demo=1` to the URL for synthetic data — useful for looking at the
layout without waiting for a swell.

## Putting it on your phone

1. Deploy it (below), or serve it over HTTPS somewhere.
2. Open the URL in Safari (iOS) or Chrome (Android).
3. **Share → Add to Home Screen**.

It then launches full-screen like an app, and the service worker keeps the shell
cached so it opens instantly. The forecast itself is cached in `localStorage`
for 30 minutes and the app tells you when it's showing stale data rather than
quietly serving you yesterday's swell.

## Deploying

`.github/workflows/deploy.yml` runs the tests and publishes to GitHub Pages on
every push to `main`. Enable it once:

**Settings → Pages → Build and deployment → Source: GitHub Actions**

Your app lands at `https://<user>.github.io/<repo>/`. Everything is
relative-pathed, so a project subpath works without configuration.

## Connecting Google Calendar

Optional. With it connected, sessions clashing with your diary are dropped, and
part-free evenings are trimmed to the time you actually have (with a travel
buffer either side).

There is no server in this app, so it uses Google's browser-side OAuth flow.
That needs an OAuth **client ID** of your own — it isn't a secret, and it only
works from the exact origin you register.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a project (or reuse one).
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → External → fill in the app name
   and your email. Add yourself under **Test users** — you don't need to publish
   or get the app verified for your own use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   → Application type **Web application**.
5. Under **Authorised JavaScript origins**, add exactly where you host it:
   - `https://<user>.github.io` for Pages
   - `http://localhost:8080` if you want it working locally too
6. Copy the client ID (`…apps.googleusercontent.com`).
7. In the app: **Settings → Google Calendar** → paste the client ID, tick
   *Use my Google Calendar*, then **Sign in and pick calendars**.

Only `calendar.readonly` is requested, and only free/busy times are read — not
event titles, guests or locations. The access token lives in `sessionStorage`
and never leaves your browser. Nothing is sent anywhere: there is no backend to
send it to.

If you skip all this, the app still ranks sessions across your configured
free-time windows — it just assumes you're free during them.

## Tuning the spots

**This is the part most worth editing.** The swell windows, tide preferences and
shelter factors in `js/spots.js` are informed estimates, not surveyed data. They
are what decide whether the app agrees with what you find when you get there.

```js
{
  id: 'cullercoats',
  facing: 70,                                              // seaward normal, degrees
  swellWindow: { from: 15, to: 120, best0: 45, best1: 90 }, // swell arrives FROM
  shelter: 0.82,                                           // headlands knock size down
  tide: { ok0: 0.25, best0: 0.5, best1: 0.9, ok1: 1.0 },    // 0 = low water, 1 = high
  dirWeight: 2.0,   // how sharply an off-window swell kills it
  tideWeight: 1.3,  // how much the tide matters here
}
```

If the app keeps telling you Cullercoats is good when the bay is flat, pull
`shelter` down or tighten `swellWindow`. If it under-rates a spot at low water,
move the `tide` band. Same for `js/craft.js` if the size bands don't match what
you're happy paddling.

Spots currently covered: Cullercoats Bay, Tynemouth Longsands, King Edward's
Bay, Whitley Bay, Seaton Sluice, Blyth South Beach.

## How the score works

Five components, each 0–1, in two stages:

**Stage 1 — the wave** (`size`, `power`). This sets the ceiling. `power`
combines wave period with steepness (`Hs / 1.56T²`), period leading.

**Stage 2 — the conditions** (`wind`, `direction`, `tide`). These are
*permissive*: they decide how much of that wave survives to the beach. They can
only reduce the score, never raise it.

```
score = wave × conditions^0.85 × 9.7
```

Two stages rather than one average, because "nothing is wrong" is not the same
as "this is good". A flat calm morning at perfect tide with a textbook offshore
breeze is still a flat calm morning, and a flat average over all five components
scored it a 7.

Other details worth knowing:

- **Swell direction attenuates height**, not just the score. A swell from
  outside a bay's window doesn't arrive small — it doesn't arrive. This is what
  makes an out-of-window day read as flat instead of mediocre.
- **Ideal bands have a gentle dome**, so the middle of a band beats its edges —
  a 1.1 m day and a 0.7 m day are not the same day.
- **Wind is resolved against the beach's own normal**, so "offshore" means
  offshore *here*, not a fixed compass direction.
- **The ceiling is 9.7**, so a 10 stays rare.
- **Hard caps** override the maths for size beyond the craft's limit and for
  strong offshore wind — judgements the weighted mean must not be able to talk
  its way out of.

Breaking face height is shown as roughly 1.4 × significant wave height, which is
what you'd call it standing on the beach.

## Data

[Open-Meteo](https://open-meteo.com/) — free, keyless, no rate limit for
personal use. Two endpoints merged on the hour: the Marine API for waves, sea
temperature and sea level, and the Forecast API for wind, air temperature and
sunrise/sunset.

Tide state is derived from the modelled `sea_level_height_msl` series:
normalised against the surrounding tidal cycle, differentiated for
rising/falling, with high and low waters found as turning points. **It is a
model, not Admiralty tide tables** — fine for timing a session, not for
navigation.

## Limitations, honestly

- Wave data is offshore model output. It knows nothing about sandbanks, which is
  most of what decides whether a North East beach break is any good on the day.
- Spot parameters are estimates (see above).
- Tides are modelled, not predicted from harmonic constituents.
- The score is a starting point, not a decision. Look at the sea.

Helmet, buoyancy aid, and either a roll you trust or someone with you.
