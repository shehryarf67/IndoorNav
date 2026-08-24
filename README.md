# MallNav — Indoor Navigation Prototype Suite

Interactive prototypes for **MallNav**, an indoor navigation platform for shopping
malls ("Google Maps for inside a mall"). GPS does not work indoors, so the two hard
problems are:

1. **Turning a physical building into a navigable map cheaply**, and
2. **Estimating a user's position without GPS.**

This repo is a single React app with three tabs, each proving one piece of the
concept. Everything runs client-side on a simulated two-level mall — no backend,
no database, no real Wi-Fi hardware.

## Run it

```bash
npm install && npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

```bash
npm run build
```

Produces a static `dist/` folder, deployable to Vercel as-is.

## The three prototypes

| Tab | What it proves |
| --- | --- |
| **Auto Map Builder** | A floor plan can be turned into a routable navigation graph automatically, in milliseconds instead of the 30–40 minutes a human takes to trace one by hand. Routes with A*, across two levels, with a step-free accessibility mode. |
| **Wi-Fi Positioning** | A phone can be located indoors from Wi-Fi signal strength alone — and pattern-matching (fingerprinting) beats the intuitive geometric method (trilateration) by roughly 7x indoors, because walls break the geometry. Also shows the radio map can be *predicted* from the floor plan rather than surveyed on foot. |
| **Positioning Fusion** | No single sensor is trustworthy. QR anchors, dead reckoning, Wi-Fi fingerprinting and map matching are layered by confidence to produce a blue dot that tracks the user and does not walk through walls. |

Every tab has a collapsible **explainer panel** covering what it is, the concept,
a legend for every visual element on screen, and why it matters for the product.

## Project layout

```
src/
  floorplan/
    geometry.js     Pure 2D maths: distances, segment intersection, wall counting,
                    point-in-rectangle, projection onto a segment.
    floorplan.js    THE shared floor plan. The two-level mall defined as data —
                    walls as line segments, corridors as walkable rectangles,
                    shop units, Wi-Fi access points, escalator/stairs/lift.
                    All three tabs import this, so the demo reads as one system.
  lib/
    navGraph.js     Derives the navigation graph from the corridor geometry, and
                    searches it with A*. (Tab 1)
    wifi.js         The positioning engine: propagation model, radio-map
                    generation, weighted-kNN fingerprinting, least-squares
                    trilateration, batch evaluation. (Tabs 2 and 3)
    signalColor.js  The two sequential colour ramps — signal strength in dBm,
                    positioning error in metres — with their legend thresholds.
    fusion.js       The confidence ladder: the walking route, QR anchors, the
                    dead-reckoning error model, and the per-tick fusion step
                    that layers all four methods. (Tab 3)
  components/
    FloorPlanSvg.jsx   The one SVG renderer used by all three tabs. Each tab
                       passes its own overlay as children.
    ExplainerPanel.jsx The four-section explainer used on every tab.
    ui.jsx             Shared buttons, toggles, sliders, stat readouts.
  tabs/
    MapBuilderTab.jsx       Tab 1
    WifiPositioningTab.jsx  Tab 2
    FusionTab.jsx           Tab 3
```

## Conventions worth knowing before reading the code

- **All coordinates are in metres**, in one building coordinate system, with
  `x` growing right and `y` growing **downward**. y-downward matches SVG's native
  axes, so rendering never needs an axis flip.
- **Every SVG uses a viewBox measured in metres** (`0 0 60 40` plus a margin).
  That means the drawing code plots points in the same units the maths works in —
  there is no metres-to-pixels conversion anywhere to get wrong. Strokes use
  `vector-effect="non-scaling-stroke"` so hairlines stay crisp at any display size.
- **The floor plan is data, not an image.** Walls are `{x1, y1, x2, y2}` segments;
  walkable corridors are rectangles; access points are `{x, y}` coordinates.

## The building

A 60 m x 40 m two-level mall. Each level has one wide horizontal corridor and one
wide vertical corridor crossing it, forming a plus-shaped walkable area, with shop
units filling all four quadrants — some fronting the horizontal corridor, some the
vertical one. Level 1 is fashion and retail with a supermarket anchor; Level 2 is
food, cinema and electronics.

Three vertical links connect the levels: an **escalator** and **stairs** on the
cross concourse, and a **lift** deliberately placed far east. That placement is
what makes the accessibility toggle meaningful — turning on step-free routing
forces the lift and visibly lengthens the route.

Seven Wi-Fi access points per level sit along the corridors, where a mall's IT
contractor actually puts them. Their positions are intentionally not symmetric,
which is what creates the weak coverage zones that Tab 2's error map exposes.

## Headline results

Measured by the app itself, not quoted from anywhere. Reproducible — every
random sequence in the project is seeded.

**Tab 1 — map digitization**

| | |
| --- | --- |
| Graph derivation | ~0.15 ms for both floors (75 nodes, 76 edges) |
| Equivalent manual tracing | ~70 min (35 min per floor) |
| A* efficiency | examines ~26 of 75 nodes to prove a route optimal |
| Accessibility cost | Khaadi → Cinepax: 46 m via escalator, 86 m step-free via lift |

**Tab 2 — positioning accuracy** (400 random positions across both levels)

| Metric | Fingerprinting | Trilateration |
| --- | --- | --- |
| Mean error | **1.74 m** | 14.9 m |
| Median error | 1.42 m | 16.6 m |
| 90th percentile | 3.40 m | 25.7 m |
| Within 3 m | 85.8% | 10.2% |
| Within 5 m | 97.8% | 19.6% |
| Correct floor | 100% | cannot determine |
| No solution produced | 0 | 38 (9.5%) |

Radio map: 640 reference points at 1.5 m spacing in ~35 ms, versus ~16 hours of
walking a manual site survey.

Under model mismatch — the radio map still built on n = 2.8 and 6.5 dB per wall
while reality is n = 3.4, 10 dB per wall and +6 dB of crowd absorption —
fingerprinting degrades from 1.74 m to 5.82 m. Degraded, but still usable. That
is the honest limitation of a predicted map, and the sliders let a panel push on
it live.

**Tab 3 — fusion** (mean error over the 68 m route, averaged across 12 seeds)

The user scans **one** QR code, at the entrance directory board, to start the
session. Everything after that is the phone's own work — scanning is a deliberate
act, not a beacon that fires as you walk past, so nothing auto-corrects.

Error is reported as **horizontal** distance, with floor correctness as its own
separate metric — the same convention as Tab 2. Folding them into one number
would hide the failure that matters most: being sub-metre accurate on the wrong
level is not sub-metre accuracy.

| Layers active | Mean error | Final error | Floor correct | Scans |
| --- | --- | --- | --- | --- |
| All four | **1.03 m** | 1.1 m | 100% | 1 |
| No Wi-Fi (DR + map matching) | 5.0 m | 13.8 m | 65% | 1 |
| Dead reckoning alone | 5.4 m | 13.1 m | 65% | 1 |
| Dead reckoning alone + 1 recovery scan | 2.2 m | 3.4 m | 67% | 2 |
| Wi-Fi + map matching | 5.6 m | 6.4 m | 100% | 1 |

The entrance scan is the starting gun, not a contributor — "all four layers" and
"the same minus QR after the entrance" measure identically. QR anchors earn their
place on the **recovery** path: one deliberate re-scan when the dot has visibly
drifted cuts mean error from 5.4 m to 2.2 m.

Four findings worth pointing at during a defence:

- Dead reckoning alone spends **35% of the walk on the wrong floor**, because a
  step counter cannot feel an escalator. Only Wi-Fi or a QR scan recovers it.
- Wi-Fi alone is accurate but too slow to drive a smooth dot, so it visibly
  trails the walker.
- A QR scan does **not** reduce error to zero. The code encodes *its own*
  coordinates, so scanning places you where the code is; the residual is however
  far you are standing from it, bounded by the 1.8 m scan range. Snapping to the
  true position would overstate what the method delivers.
- Map matching barely helps here (5.4 m → 5.0 m). It corrects error *across* a
  corridor but is blind to error *along* it, and unaided dead-reckoning drift is
  mostly along-corridor.

None of the first two is fixable within a single method — which is the argument
for the ladder.
