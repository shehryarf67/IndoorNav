import { useState } from 'react';
import MapBuilderTab from './tabs/MapBuilderTab.jsx';
import WifiPositioningTab from './tabs/WifiPositioningTab.jsx';
import FusionTab from './tabs/FusionTab.jsx';

/**
 * App — the shell holding the three prototypes.
 *
 * Each tab proves one piece of the MallNav concept:
 *   1. A building can be turned into a routable map automatically.
 *   2. A phone can be located indoors from Wi-Fi alone, and the radio map that
 *      makes that possible can be predicted rather than surveyed.
 *   3. No single sensor is trustworthy, so the product layers them by confidence.
 *
 * All three read the same floor plan module, so the demo reads as one system.
 */

const TABS = [
  {
    id: 'map',
    label: 'Auto Map Builder',
    caption: 'Floor plan → navigable graph',
    Component: MapBuilderTab,
  },
  {
    id: 'wifi',
    label: 'Wi-Fi Positioning',
    caption: 'Fingerprinting vs trilateration',
    Component: WifiPositioningTab,
  },
  {
    id: 'fusion',
    label: 'Positioning Fusion',
    caption: 'The confidence ladder',
    Component: FusionTab,
  },
];

export default function App() {
  const [active, setActive] = useState('map');
  const ActiveComponent = TABS.find((t) => t.id === active).Component;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-end justify-between gap-4 px-6 pt-5">
          <div>
            <h1 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight text-ink">
              MallNav
              <span className="text-xs font-normal text-ink-soft">
                Indoor navigation for shopping malls
              </span>
            </h1>
            <p className="mt-0.5 text-xs text-ink-faint">
              Prototype suite — three demonstrations running entirely in the browser on a
              simulated two-level mall
            </p>
          </div>
          <p className="text-[11px] text-ink-faint">
            Final Year Project · no backend, no hardware — all positioning maths computed
            client-side
          </p>
        </div>

        {/* Tab bar */}
        <nav className="mx-auto max-w-[1500px] px-6" aria-label="Prototypes">
          <div className="mt-4 flex gap-1">
            {TABS.map((t) => {
              const isActive = t.id === active;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActive(t.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group -mb-px rounded-t-lg border border-b-0 px-4 py-2.5 text-left transition-colors ${
                    isActive
                      ? 'border-line bg-canvas'
                      : 'border-transparent hover:bg-canvas/60'
                  }`}
                >
                  <span
                    className={`block text-sm font-semibold ${
                      isActive ? 'text-brand' : 'text-ink-soft group-hover:text-ink'
                    }`}
                  >
                    {t.label}
                  </span>
                  <span className="block text-[11px] text-ink-faint">{t.caption}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-[1500px] px-6 py-6">
        <ActiveComponent />
      </main>
    </div>
  );
}
