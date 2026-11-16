# Multi-floor navigation — integration plan

Branch: `feature/multi-floor`. Nothing here touches `main` until it is tested and
merged deliberately.

## Status — paused after Phase 2

| Phase | State |
| --- | --- |
| 0 — Data model | ✅ done |
| 1 — Routing | ✅ done |
| 2 — Floor positioning | ✅ done (engine + tests; **no UI yet** — see Phase 3) |
| 3 — UX | not started |
| 4 — Plan alignment | not started |

Also done along the way: a performance pass (calibration 18.8 s → ~0.16 s,
bit-identical output; full test suite 11.1 s → ~4.4 s with 26 tests).

### Phase 2 results (20 seeds per cell, realistic 30 s Wi-Fi scans)

| Route | Barometer | Median floor-change latency | Changes never detected | Floor correct | Mean error |
| --- | --- | --- | --- | --- | --- |
| Entrance (escalator) | off | 12.5 s | 4 / 20 | 79.6% | 2.42 m |
| Entrance (escalator) | **on** | **3.1 s** | **0 / 20** | **96.2%** | **2.25 m** |
| Car park (lift, 2 floors) | off | 11.2 s | 0 / 20 | 91.0% | 2.01 m |
| Car park (lift, 2 floors) | **on** | **3.7 s** | **0 / 20** | **97.2%** | 2.21 m |

Barometer false positives: 0. Transition type (lift / escalator / stairs)
classified correctly in 79 of 80 rides across both routes and both scan rates. With fast 4 s scans the barometer is at
parity (1.38 vs 1.37 m entrance; 1.64 vs 1.69 m car park).

### Open findings to pick up on resume

- **Car-park horizontal cost.** On the lift route the barometer costs ~0.2 m of
  horizontal accuracy (2.00 → 2.22 m, even counting only ticks on the right
  floor — so it is real, not an artifact of the floors sharing a layout).
  Untested hypothesis: global Wi-Fi re-localisation (the no-barometer path)
  resets accumulated along-corridor drift, which the barometer's local
  transition does not.
- **Stairs steps are not fed to dead reckoning.** The step counter counts stair
  steps for the classifier only; a real phone would also (wrongly) move the
  estimate horizontally. Modelling that is future work.
- **No route in Tab 3 uses stairs**, so stairs are covered by the unit tests
  only, not by an end-to-end walk.

### Where Phase 3 resumes

The engine is complete but `FusionTab.jsx` does not expose it yet:

1. Add a **Barometer** layer toggle (`layers.baro`, currently always off in the
   UI) and include it in the presets.
2. Add a **route selector** for `WALK_ROUTES` (`entrance`, `carpark`) —
   `buildWalkPlan(route)` already accepts one.
3. Show the barometer evidence: relative height (`state.baro.relativeHeightM`),
   detected changes (`state.floorChanges`), and the latency metric
   (`state.floorChangeLatencies`); give `'baro'` events their own badge in the
   correction log.
4. Tab 1: a **route-profile selector** (`ROUTE_PROFILES`), a connector
   out-of-service toggle, and step-by-step directions from `routeInstructions()`.
5. Update README headline numbers and the provenance table (barometer model).

Evaluation harness used for the table above: route × barometer × scan interval,
20 seeds, measuring latency from true arrival on the new floor to the app
agreeing. Rebuild it from `test/floorchange.test.js` (end-to-end test) if needed.

## Goal

Generalise MallNav from a hard-wired two-floor demo to genuine N-floor navigation:
route correctly between any floors, respect how real vertical circulation works,
and know which floor the user is on — and *when they changed it* — quickly and
reliably.

## Baseline (main @ 3e0cadb)

| Measure | Value |
| --- | --- |
| Tests | 6 / 6 pass |
| Graph | 75 nodes, 76 edges, 2 floors |
| Khaadi → Cinepax | 46.0 m, 59 s, escalator |
| Cinepax → Khaadi | 46.0 m, 59 s, **rides the same escalator down** |
| Fingerprinting | 1.74 m mean, 100% floor accuracy |
| Tab 3 floor-change detection | next Wi-Fi scan + global re-localisation (up to ~30 s) |

## Defects found in the current design

1. Floors are hard-wired to 1 ↔ 2 (`navGraph.js` connector stitching,
   `MapBuilderTab.jsx` hand-off marker). A third floor breaks both.
2. Every graph edge is two-way, so escalators run in both directions.
3. Floors have no ordering or height, so nothing can reason about "up".
4. Connector cost (`costM`) and connector time (`seconds`) are independent
   hand-picked numbers that disagree with each other.
5. The particle filter can only change floor by declaring itself lost.

## Phases

### Phase 0 — Data model
- Levels gain `ordinal`, `elevationM`, `shortName`.
- `VERTICAL_LINKS` becomes `CONNECTORS`: `servesLevels`, `direction`
  (`up` / `down` / `both`), `waitS`, `secondsPerFloor`, `accessible`, `inService`.
- Escalators become an up / down pair.
- Add a **parking level below ground**, reached only by lift and stairs — this
  forces connectors that serve different sets of floors, and flushes out every
  two-floor assumption.

**Done when:** all three tabs run on three floors; existing tests pass.

### Phase 1 — Routing
- Directed edges: escalators one-way, corridors / stairs / lifts two-way.
- Connector cost derived from time, `cost = (waitS + secondsPerFloor × Δfloors) ×
  walking speed`, so one number drives both routing and the time readout.
- A connector serving N floors gets an edge for every pair it serves, so a lift
  ride pays its wait once, not once per floor.
- Admissible heuristic generalised to `|Δordinal| × cheapest cost per floor`.
- Route profiles: fastest, step-free, avoid escalators.
- Out-of-service connectors excluded at query time.
- Route legs with turn-style instructions: "Take the up-escalator to Level 2".

**Done when (tested):** never rides an escalator the wrong way; a disabled lift is
never used; step-free never uses stairs or escalators; parking ↔ upper floors
routes via lift or stairs only; A* matches Dijkstra on every shop pair (proof the
heuristic is admissible); full all-pairs routing stays fast.

### Phase 2 — Floor positioning
- Simulated **barometer**: relative pressure from elevation, plus weather drift and
  sensor noise. Floor changes are judged from *relative* change, never absolute
  pressure.
- **Connector-constrained floor transitions** in the particle filter: a particle may
  change floor only within reach of a connector that serves that change. Floors
  change by ordinary propagation rather than "lost → rebuild everything", so the
  learnt compass hypotheses survive.
- Wi-Fi floor vote kept as confirmation; global re-localisation kept as last resort.

**Done when (measured, multiple seeds):** floor-change detection latency drops from
~30 s to a few seconds; floor accuracy ≥ baseline; horizontal error no worse.

### Phase 3 — UX
- Floor switchers, legends and hand-off markers generic over N floors.
- Route instructions panel; destination floor shown ghosted.
- Barometer readout in Tab 3, so the floor-change evidence is visible.

### Phase 4 — Multi-floor plan alignment (later)
- Register each floor's plan into one frame using vertically continuous features
  (lift shafts, stair cores) as tie points, by least-squares affine fit.

## Merge criteria

Build and lint clean; all tests pass (old and new); headline numbers re-measured and
README updated; each phase committed separately with before / after numbers.
