/**
 * signalColor.js — colour ramps for the two maps in Tab 2.
 *
 * Both ramps are SEQUENTIAL (ordered light-to-dark), because both encode a
 * quantity with a natural direction: signal strength, and positioning error.
 * Binning rather than smoothly interpolating is deliberate — discrete bands can
 * be read off a legend exactly, and the sharp band boundary at each storefront
 * is the thing we want the viewer to notice.
 */

/**
 * Wi-Fi signal strength ramp, keyed in dBm.
 *
 * Single-hue purple, matching the access-point markers, running from a strong
 * signal (dark) to nothing at all (near-white). The thresholds are the ones a
 * network engineer uses in practice: -50 dBm is excellent, -70 dBm is the
 * usable limit, below -85 dBm you effectively cannot hear the AP.
 */
export const RSSI_BANDS = [
  { min: -50, color: '#3b0764', label: '≥ −50', note: 'excellent' },
  { min: -57, color: '#5b21b6', label: '−57', note: 'strong' },
  { min: -64, color: '#7c3aed', label: '−64', note: 'good' },
  { min: -71, color: '#a78bfa', label: '−71', note: 'usable' },
  { min: -78, color: '#c4b5fd', label: '−78', note: 'weak' },
  { min: -86, color: '#ddd6fe', label: '−86', note: 'very weak' },
  { min: -95, color: '#f0edff', label: '−95', note: 'barely heard' },
  { min: -Infinity, color: '#fafafa', label: '< −95', note: 'not heard' },
];

/** Colour for a given RSSI in dBm. */
export function rssiColor(rssi) {
  for (const band of RSSI_BANDS) {
    if (rssi >= band.min) return band.color;
  }
  return RSSI_BANDS[RSSI_BANDS.length - 1].color;
}

/**
 * Positioning-error ramp, keyed in metres.
 *
 * Green through amber to red. The break points are product decisions, not
 * arbitrary: under 2 m you can be told which shop you are outside, under 5 m
 * turn-by-turn still works, and beyond 8 m the blue dot is misleading enough
 * that the app needs a correction anchor at that spot.
 */
export const ERROR_BANDS = [
  { max: 2, color: '#15803d', label: '< 2 m', note: 'shop-level accuracy' },
  { max: 3, color: '#65a30d', label: '2–3 m', note: 'good' },
  { max: 5, color: '#eab308', label: '3–5 m', note: 'usable for navigation' },
  { max: 8, color: '#f97316', label: '5–8 m', note: 'degraded' },
  { max: Infinity, color: '#dc2626', label: '> 8 m', note: 'needs a QR anchor' },
];

/** Colour for a positioning error in metres. */
export function errorColor(metres) {
  for (const band of ERROR_BANDS) {
    if (metres < band.max) return band.color;
  }
  return ERROR_BANDS[ERROR_BANDS.length - 1].color;
}
