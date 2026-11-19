# Multi-floor navigation — integration plan

Branch: `feature/multi-floor`. Nothing here touches `main` until it is tested and
merged deliberately.

## Status

| Phase | State |
| --- | --- |
| 0 — Data model | ✅ done |
| 1 — Routing | ✅ done |
| 2 — Floor positioning | ✅ done |
| 3 — UX | ✅ done |
| 4 — Plan alignment | ✅ done (anchors clicked by hand; detecting lift/stair symbols in images is future work) |

Phase 2's open findings were all resolved in the Phase 3 pass: the car-park
barometer cost (+0.22 m → +0.02 m; root cause an overconfident heading model),
stair steps misread as walking (now modelled, and gated by the barometer), the
missing stairs walk (added, which exposed and fixed two-floor stair descents being
split into two floor changes), and the misclassification (0 in 360 rides). Current
numbers live in README.md → Headline results.

Remaining known limitations: stairs take ~5 s to confirm (slow climbs need a
longer measuring window); the first ~2 s of a stair climb slips past the step
gate (~1.5 m twitch at the top of the stairs); steps held back during an
abandoned floor change are not replayed.

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
