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
