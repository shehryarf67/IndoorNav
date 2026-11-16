# MallNav — Indoor Navigation Prototype Suite

Interactive prototypes for **MallNav**, an indoor navigation platform for shopping
malls ("Google Maps for inside a mall"). GPS does not work indoors, so the two hard
problems are:

1. **Turning a physical building into a navigable map cheaply**, and
2. **Estimating a user's position without GPS.**

This repo is a single React app with three tabs, each proving one piece of the
concept. Everything runs client-side on a simulated three-level mall — no backend,
no database, no real Wi-Fi hardware.

## Run it

```bash
npm install && npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

```bash
npm run build
npm test
```

Produces a static `dist/` folder, deployable to Vercel as-is.

## The three prototypes

| Tab | What it proves |
| --- | --- |
| **Auto Map Builder** | Derives a routable graph in visible stages, validates connectivity, routes across levels, and repeats the pipeline on an unseen irregular annex. Step-free mode overlays the fastest and accessible alternatives. |
| **Wi-Fi Positioning** | Compares fingerprinting with trilateration, exposes parameter and model-class mismatch, and recovers AP positions plus propagation parameters from a short calibration walk. |
| **Positioning Fusion** | Runs the layered estimator beside a synchronized dead-reckoning baseline, narrates failures and recoveries, and grades whether self-assessed confidence matches simulation truth. |

Every tab has a collapsible **explainer panel** covering what it is, the concept,
a legend for every visual element on screen, and why it matters for the product.

## Project layout

```
src/
  floorplan/
    geometry.js     Pure 2D maths: distances, segment intersection, wall counting,
                    point-in-rectangle, projection onto a segment.
    floorplan.js    THE shared floor plan. The three-level mall defined as data —
                    walls as line segments, corridors as walkable rectangles,
                    shop units, Wi-Fi access points, escalator/stairs/lift.
                    All three tabs import this, so the demo reads as one system.
    alternateFloorplan.js  Structurally different unseen annex used to check
                    whether graph derivation generalises beyond the main mall.
  lib/
    navGraph.js     Derives the navigation graph from the corridor geometry, and
                    searches it with A*. (Tab 1)
    wifi.js         The positioning engine: propagation model, radio-map
                    generation, weighted-kNN fingerprinting, least-squares
                    trilateration, batch evaluation. (Tabs 2 and 3)
    apCalibration.js  Short-walk AP/floor recovery and propagation-parameter fit.
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

A 60 m x 40 m mall on three levels: a basement car park (Level P), the ground
floor (Level 1, fashion and retail with a supermarket anchor) and Level 2 (food,
cinema and electronics). Each level has one wide horizontal corridor and one wide
vertical corridor crossing it, forming a plus-shaped walkable area, with units
filling all four quadrants.

Floors are joined by **connectors**, each with the floors it serves, its
direction, and its wait and travel time:

| Connector | Serves | Direction | Notes |
| --- | --- | --- | --- |
| Up-escalator / down-escalator | L1, L2 | one-way each | Side by side on the cross concourse |
| Stairs | P, L1, L2 | both | |
| Lift | P, L1, L2 | both | The only step-free connector; deliberately placed far east |

The car park is reached **only** by the stairs and the lift — no escalator goes
there — which is what makes routing to and from it non-trivial.

There are 18 Wi-Fi access points: seven per shopping floor along the corridors,
and only four in the car park, because basements are characteristically
under-served. Positions are intentionally not symmetric, which creates the weak
coverage zones that Tab 2's error map exposes.

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
| Wi-Fi scan interval (30 s) | Real Android platform constraint | Android 9+ throttles a foreground app to 4 scans per 2 minutes. Scans arrive on a random-phase schedule, and one that lands mid-ride is wasted. |
| Barometer: −0.12 hPa/m, 0.04 hPa noise, weather/HVAC drift | Standard atmosphere; typical phone MEMS sensor | Realistic order of magnitude. The detector uses relative pressure only. Many budget phones have no barometer at all. |
| Stair steps counted as full 0.72 m strides | Modelled phone behaviour | Real step counters make this mistake; the app counters it with the barometer gate. |
| Storey height 4.5 m, connector wait and ride times | Chosen | Plausible, not measured. |
| "35 min manual tracing" (Tab 1's denominator) | Assumption | **Unvalidated.** It is the denominator of the project's biggest claim — worth timing for real. |

**The deepest caveat is in Tab 2.** The radio map is generated by
`RSSI = P0 − 10n·log₁₀(d) − walls×loss`, and the "ground truth" readings it is
tested against are generated by the *same functional form*, differing only in
parameter values. Real propagation has multipath, diffraction, reflection and
body shadowing, none of which have that form. So **1.61 m is an optimistic floor,
not a prediction** — published Wi-Fi fingerprinting in real malls typically lands
at 3–8 m. The stress controls now add per-AP hardware offsets and spatially
correlated fading, which break the fitted model class, but remain synthetic rather
than a replacement for measurements in a real venue.

Two cheap measurements would remove most of this exposure: time yourself tracing
one floor by hand, and fit `n` and `wall_loss` from 20–30 RSSI samples in any
real building.

## Headline results

Measured by the app itself, not quoted from anywhere. Reproducible — every
random sequence in the project is seeded.

**Tab 1 — map digitization and routing**

| | |
| --- | --- |
| Graph derivation | ~0.18 ms for all three floors (103 nodes, 108 edges) |
| Input | Structured corridor/shop geometry; image segmentation remains future work |
| A* efficiency | explores 24.6 nodes on average vs 55.4 for Dijkstra, for the identical optimal route |
| Route profiles | Fastest · Step-free (lift only) · Avoid escalators |
| Accessibility cost | Khaadi → Cinepax: 49.6 m / 62 s by up-escalator; 86.0 m / 114 s step-free by lift |
| Out of service | Any connector can be disabled; a step-free trip with the lift down returns *no route*, with the reason, rather than quietly sending a wheelchair user to the stairs |
| Generalisation check | Rebuilds and validates a graph for the unseen Atrium Annex |

Escalators are one-way: the trip back down uses the down-escalator. A lift ride
across two floors pays its wait once. The test suite routes all ~2,160 shop pairs
under every profile and checks A* against Dijkstra on each.

**Tab 2 — positioning accuracy** (400 random positions across all three floors)

| Metric | Fingerprinting | Trilateration |
| --- | --- | --- |
| Mean error | **1.61 m** | 15.9 m |
| Median error | 1.38 m | 16.9 m |
| 90th percentile | 3.20 m | 26.9 m |
| Within 3 m | 89.5% | 8.0% |
| Within 5 m | 99.0% | 14.8% |
| Correct floor | 100% | cannot determine |
| No solution produced | 0 | 75 (18.8%) |

Radio map: 960 reference points × 18 APs at 1.5 m spacing in ~21 ms, versus
~24 hours of walking a manual site survey.

The calibration view replaces the assumption that AP coordinates are already
known with a reproducible short walk: 10 corridor stops per floor (30 in all),
eight averaged scans per stop, then a coarse-to-fine AP search and least-squares
fit. In the seeded simulation it recovers every AP's floor with about half-metre
mean AP-position error. True AP rings are shown only for grading.

Under model mismatch — the radio map still built on n = 2.8 and 6.5 dB per wall
while reality is n = 3.4, 10 dB per wall and +6 dB of crowd absorption —
fingerprinting degrades from 1.61 m to 5.70 m. Degraded, but still usable.

**Tab 3 — fusion across floors**

Three walks, each starting from **one** QR scan the user would make anyway:

| Walk | Floors | Connector |
| --- | --- | --- |
| Front entrance → Metro Shoes | L1 → L2 | Up-escalator |
| Car park → Cinepax Cinema | P → L2 | Lift (two floors) |
| Food court → Parking Zone D | L2 → P | Stairs (two floors) |

The estimator is a **particle filter**: a cloud of 400 weighted hypotheses, each
carrying its own guess at how wrong the compass and step length are. Each layer
is one operation on that cloud:

| Layer | Filter operation |
| --- | --- |
| Dead reckoning | propagate every particle by its own error hypothesis |
| Map matching | delete particles that walked through a wall |
| Wi-Fi fingerprinting | re-weight by fingerprint likelihood, then resample |
| Barometer | on a detected floor change, move the cloud through a connector that could have made it |
| QR scan | collapse the whole cloud onto a known point |

Error is reported as **horizontal** distance, with floor correctness as its own
metric — being sub-metre accurate on the wrong floor is not sub-metre accuracy.

Layer contributions on the escalator walk, at the realistic 30 s Wi-Fi scan
interval (10 seeds):

| Layers active | Mean error | Floor correct | Dot inside a wall |
| --- | --- | --- | --- |
| All five | **2.12 m** | 96.4% | **0.0%** |
| No barometer | 2.57 m | 80.6% | 0.0% |
| No map matching | 2.68 m | 96.6% | 12.0% |
| No Wi-Fi | 2.86 m | 96.3% | 0.0% |
| Dead reckoning alone | 4.13 m | 68.6% | 10.6% |

What the barometer does on each route (20 seeds, 30 s scans):

| Walk | Barometer | Time to notice the new floor (median) | Changes never noticed | Floor correct | Mean error |
| --- | --- | --- | --- | --- | --- |
| Escalator | off | 12.5 s | 4 of 20 | 79.6% | 2.44 m |
| Escalator | **on** | **2.7 s** | **0** | **96.4%** | 2.24 m |
| Lift | off | 11.2 s | 0 | 91.0% | 1.79 m |
| Lift | **on** | **3.7 s** | **0** | **97.0%** | 1.82 m |
| Stairs | off | 10.8 s | 1 of 20 | 88.5% | 3.72 m |
| Stairs | **on** | **5.0 s** | **0** | **95.5%** | 2.25 m |

How it works, and why each part exists:

- **Relative pressure only.** One storey is ~0.54 hPa, but weather moves absolute
  pressure by several hPa a day, so the detector only reads change and
  re-anchors on every floor. No false floor changes were seen in any run.
- **A floor change is confirmed once the height has moved most of a storey and
  stopped moving**, so the app never switches floor halfway up an escalator.
  It then looks back for the true arrival time, and classifies the ride as
  lift, escalator or stairs from vertical speed and steps during the climb only
  (0 misclassified in 360 rides).
- **Vertical map matching.** A particle may only change floor through a
  connector within reach that serves both floors, runs that way and is in
  service — nobody changes floor mid-corridor. Survivors land at the
  connector, so a floor change is also a free position fix. The steps walked
  since arrival are then replayed.
- **Barometer-gated dead reckoning.** A phone's step counter counts stair steps
  as full strides. While the barometer shows climbing, those steps are held back
  from dead reckoning: error during a stair descent falls from 5.2 m to 2.4 m.
- **Honest scan scheduling.** An earlier version deferred any Wi-Fi scan that fell
  mid-ride to the moment after arrival, making floor changes look instantly
  detected. Without the barometer, the true time to notice is 11–12 s at
  realistic scan rates, and on the escalator walk 4 of 20 walks never notice it
  at all.
- **Uncertainty is self-assessed.** The halo is the cloud's own spread, computed
  without the true position. A heading-model consistency check (true heading
  error over the cloud's heading spread, ~1.0 on every route) confirms the
  filter is neither over- nor under-confident.

Stairs take longer to confirm than an escalator or lift (median 5.0 s). Stairs
climb slowly enough that telling "stopped" from "still climbing" needs a longer
measuring window.

## Automated checks

`npm test` runs 38 tests in about 13 s:

- geometry, wall counting and graph connectivity on every floor plan;
- multi-floor routing across every shop pair and profile: escalator direction,
  step-free and avoid-escalator rules, out-of-service connectors, A* == Dijkstra;
- the barometer detector on synthetic traces (no phantom changes standing still
  for ten minutes; escalator, two-floor lift and stair rides each detected once,
  with the right direction and type);
- end-to-end floor changes on all three walks, the stair-step gate, and a
  barometer-only walk with no QR scan and no Wi-Fi;
- deterministic radio behaviour, the positioning envelope, AP-calibration recovery,
  and performance guards proving the optimisations changed speed, not results.

`npm run lint` and `npm run build` remain the static and production-bundle checks.
