import { useState } from 'react';
import MapBuilderTab from './tabs/MapBuilderTab.jsx';
import WifiPositioningTab from './tabs/WifiPositioningTab.jsx';
import FusionTab from './tabs/FusionTab.jsx';
import { Badge } from './components/ui.jsx';
// The header names the floors from the data, so it cannot go stale again the
// way "two-level mall" did when the car park was added.
import { LEVELS } from './floorplan/floorplan.js';

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

const PROOF_STEPS = {
  map: '1 · Automate the map',
  wifi: '2 · Challenge the radio model',
  fusion: '3 · Watch the blue dot recover',
};

export default function App() {
  const [active, setActive] = useState('map');
  const [presentationMode, setPresentationMode] = useState(true);
  const ActiveComponent = TABS.find((t) => t.id === active).Component;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-end justify-between gap-4 px-4 pt-5 sm:px-6">
          <div>
            <h1 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight text-ink">
              MallNav
              <span className="text-xs font-normal text-ink-soft">
                Indoor navigation for shopping malls
              </span>
            </h1>
            <p className="mt-0.5 text-xs text-ink-faint">
              Prototype suite — three demonstrations running entirely in the browser on a
              simulated {LEVELS.length}-level mall ({LEVELS.map((l) => l.name).join(' · ')})
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge tone="warn">SIMULATED PROTOTYPE</Badge>
            <button
              type="button"
              onClick={() => setPresentationMode((v) => !v)}
              aria-pressed={presentationMode}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                presentationMode
                  ? 'border-brand bg-blue-50 text-brand'
                  : 'border-line bg-white text-ink-soft hover:text-ink'
              }`}
            >
              Supervisor demo {presentationMode ? 'on' : 'off'}
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <nav className="mx-auto max-w-[1500px] overflow-x-auto px-4 sm:px-6" aria-label="Prototypes">
          <div className="mt-4 flex min-w-max gap-1" role="tablist">
            {TABS.map((t) => {
              const isActive = t.id === active;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActive(t.id)}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`prototype-${t.id}`}
                  tabIndex={isActive ? 0 : -1}
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

      <main
        id={`prototype-${active}`}
        role="tabpanel"
        className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 sm:py-6"
      >
        {presentationMode && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-brand">
                Guided defence story
              </div>
              <p className="mt-0.5 text-sm font-semibold text-blue-950">{PROOF_STEPS[active]}</p>
            </div>
            <div className="flex gap-1" aria-label="Defence story steps">
              {TABS.map((tab, index) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActive(tab.id)}
                  aria-label={`Go to proof ${index + 1}: ${tab.label}`}
                  aria-current={tab.id === active ? 'step' : undefined}
                  className={`h-2.5 w-10 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                    tab.id === active ? 'bg-brand' : 'bg-blue-200 hover:bg-blue-300'
                  }`}
                />
              ))}
            </div>
          </div>
        )}
        <ActiveComponent presentationMode={presentationMode} />
      </main>
    </div>
  );
}
