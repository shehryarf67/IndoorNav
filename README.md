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
                    simulated sensor errors, and the per-tick step that applies
                    each layer to the particle cloud. (Tab 3)
    particleFilter.js  The estimator: propagate / constrain / re-weight /
                    resample, plus global re-localisation and reading a
                    position and an honest uncertainty out of the cloud.
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

## Where the data comes from (read this before presenting)

**There is no measured data in this project.** No real RSSI readings, no real IMU
traces, no surveyed floor plan. Every number is computed from a model. That is
the right choice for a concept demo, but the provenance is not uniform and it is
worth knowing which figures are defensible and which are judgement calls:

| What | Source | Status |
| --- | --- | --- |
| Building geometry, shop units, tenant names | Invented | A plausible schematic. Real malls are irregular, with atria, curves and mid-concourse kiosks. |
| `P0 = −40`, `n = 2.8`, `wall_loss = 6.5`, `σ = 3.5` | Ported from the project's tested Python simulation | All within literature ranges for 2.4 GHz indoor. `σ = 3.5 dB` is on the low side (4–10 dB is typical), so positioning is slightly flattered. |
| `floor_loss = 15 dB` | Chosen from literature (15–20 dB per slab) | Defensible, but a choice rather than a measurement. |
| Walking speed, stride length, escalator duration | Standard anthropometric values | Realistic. |
| Sensor error model (compass drift, stride bias) | Calibrated so unaided dead reckoning drifts 8–12% of distance | Published phone-grade pedestrian dead reckoning is 5–15%, so this is mid-range rather than chosen to make a point. |
| Wi-Fi scan interval (30 s) | Real Android platform constraint | Android 9+ throttles a foreground app to 4 scans per 2 minutes. |
| "35 min manual tracing" (Tab 1's denominator) | Assumption | **Unvalidated.** It is the denominator of the project's biggest claim — worth timing for real. |

**The deepest caveat is in Tab 2.** The radio map is generated by
`RSSI = P0 − 10n·log₁₀(d) − walls×loss`, and the "ground truth" readings it is
tested against are generated by the *same functional form*, differing only in
parameter values. Real propagation has multipath, diffraction, reflection and
body shadowing, none of which have that form. So **1.74 m is an optimistic floor,
not a prediction** — published Wi-Fi fingerprinting in real malls typically lands
at 3–8 m. The mismatch sliders vary parameters within the model class; they do
not test the model class being wrong.

Two cheap measurements would remove most of this exposure: time yourself tracing
one floor by hand, and fit `n` and `wall_loss` from 20–30 RSSI samples in any
real building.

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

The estimator is a **particle filter** — the standard approach in the literature
and in shipping products. Position is a cloud of 400 weighted hypotheses, each
carrying its own guess at how wrong the compass and step length are, and each of
the four layers is one operation on that cloud:

| Layer | Filter operation |
| --- | --- |
| Dead reckoning | propagate every particle by its own error hypothesis |
| Map matching | delete particles that walked through a wall |
| Wi-Fi fingerprinting | re-weight by fingerprint likelihood, then resample |
| QR scan | collapse the whole cloud onto a known point |

Error is reported as **horizontal** distance, with floor correctness as its own
separate metric — the same convention as Tab 2. Folding them into one number
would hide the failure that matters most: being sub-metre accurate on the wrong
level is not sub-metre accuracy.

**At the realistic 30 s Wi-Fi scan interval** (Android 9+ throttles a foreground
app to 4 scans per 2 minutes, so the phone must coast ~39 m between corrections):

| Layers active | Mean error | Final | Floor correct | Dot inside a wall |
| --- | --- | --- | --- | --- |
| All four | **2.34 m** | 2.5 m | 100% | **0.0%** |
| No map matching | 4.28 m | 5.7 m | 100% | 17.3% |
| No Wi-Fi | 2.78 m | 2.8 m | 65% | 0.0% |
| Dead reckoning alone | 5.05 m | 8.1 m | 65% | 25.4% |

With throttling disabled (4 s scans) the full stack reaches 1.62 m.

Each layer's contribution is now separable and each is necessary:

- **Map matching** halves the error (4.28 → 2.34 m) *and* eliminates wall
  violations entirely (17.3% → 0%). It works because deleting particles that
  ended up somewhere impossible is deleting wrong hypotheses about the compass —
  so the floor plan corrects drift *along* a corridor, not just across it. A
  naive snap-to-corridor cannot do that.
- **Wi-Fi** is what recovers the floor (65% → 100%). Dead reckoning cannot feel
  an escalator, so after the ride every particle is confidently on the wrong
  level. Re-weighting cannot fix that — the right answer has zero probability in
  the cloud — so the filter compares its best internal hypothesis against the
  best hypothesis anywhere in the radio map and, when it loses that comparison,
  rebuilds the cloud from scratch. That likelihood-ratio test is what triggers
  the one re-localisation per walk.
- **QR anchors** contribute one entrance scan to bootstrap, then nothing until
  the user chooses to re-scan. A scan does *not* reduce error to zero: the code
  encodes *its own* coordinates, so the residual is however far you stand from
  it, bounded by the 1.8 m scan range.
- **Uncertainty is self-assessed.** The halo is the spread of the surviving
  cloud, computed without any access to the true position, and it tracks the
  actual error closely. The reported point is the densest *cluster*, not the mean
  of the cloud — averaging a cloud torn between two corridors puts the answer in
  the shop unit between them.
