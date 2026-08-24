/**
 * ui.jsx — the small set of presentational primitives every tab reuses.
 *
 * Keeping these in one place is what makes the three prototypes look like one
 * product rather than three student projects stapled together.
 */

/** A bordered white panel with an optional heading. */
export function Panel({ title, subtitle, actions, children, className = '' }) {
  return (
    <section
      className={`rounded-xl border border-line bg-surface ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            {title && (
              <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-ink-soft">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** Primary / secondary / ghost button. */
export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  className = '',
  title,
}) {
  const styles = {
    primary:
      'bg-brand text-white hover:bg-blue-700 disabled:bg-ink-faint shadow-xs',
    secondary:
      'bg-white text-ink border border-line hover:bg-canvas disabled:text-ink-faint',
    danger: 'bg-bad text-white hover:bg-red-700 disabled:bg-ink-faint',
  }[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/** Labelled on/off switch. Every toggle in the app is one of these. */
export function Toggle({ checked, onChange, label, hint, disabled = false, accent = 'brand' }) {
  return (
    <label
      className={`flex items-start gap-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className="h-5 w-9 rounded-full bg-ink-faint/50 transition-colors peer-checked:bg-(--sw)"
          style={{ '--sw': `var(--color-${accent})` }}
        />
        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-ink-soft">{hint}</span>}
      </span>
    </label>
  );
}

/** A labelled numeric readout with units. Nothing on screen is unitless. */
export function Stat({ label, value, unit, tone = 'default', hint }) {
  const tones = {
    default: 'text-ink',
    good: 'text-good',
    bad: 'text-bad',
    brand: 'text-brand',
  };
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">
        {label}
      </div>
      <div className={`tnum mt-0.5 text-lg font-semibold leading-tight ${tones[tone]}`}>
        {value}
        {unit && <span className="ml-1 text-xs font-medium text-ink-soft">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[11px] leading-snug text-ink-soft">{hint}</div>}
    </div>
  );
}

/** A labelled slider with a live value readout and units. */
export function Slider({ label, value, min, max, step, unit, onChange, hint }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-xs font-medium text-ink">{label}</label>
        <span className="tnum text-xs font-semibold text-ink">
          {value}
          {unit && <span className="ml-0.5 font-normal text-ink-soft">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full accent-brand"
      />
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">{hint}</p>}
    </div>
  );
}

/** Labelled <select>. */
export function Select({ label, value, onChange, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-ink">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-white px-2.5 py-2 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
      >
        {children}
      </select>
    </label>
  );
}

/** Small pill badge. */
export function Badge({ children, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-canvas text-ink-soft border-line',
    good: 'bg-green-50 text-green-700 border-green-200',
    bad: 'bg-red-50 text-red-700 border-red-200',
    brand: 'bg-blue-50 text-blue-700 border-blue-200',
    warn: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
