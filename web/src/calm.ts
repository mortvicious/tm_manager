/**
 * Calm mode (docs/spa-performance.md § Calm): `html[data-calm]` while nobody is
 * looking at the app closely — the window is unfocused or hidden, nothing was
 * touched or typed for CALM_AFTER_MS, or the system asks for reduced motion.
 * theme.css § Calm stops the infinite "live" pulses under it.
 *
 * Why: any running CSS animation keeps the compositor producing frames at the
 * display's rate (120 Hz on a ProMotion Mac) for as long as it runs. With a
 * few running rows that was the whole GPU-process cost of an idle board —
 * measured 15–64 % with the pulses, 0.3 % without. The dots themselves stay,
 * at full opacity: the badge colour already says "running"; the pulse only
 * adds motion, and motion nobody is watching is pure cost.
 */

export const CALM_AFTER_MS = 60_000;

let lastInput = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;
let focused = true;
let reduced = false;

function set(calm: boolean): void {
  const el = document.documentElement;
  if (calm === el.hasAttribute('data-calm')) return;
  if (calm) el.setAttribute('data-calm', '');
  else el.removeAttribute('data-calm');
}

function evaluate(): void {
  const idle = Date.now() - lastInput >= CALM_AFTER_MS;
  set(reduced || !focused || document.visibilityState === 'hidden' || idle);
}

function arm(): void {
  if (timer !== null) return;
  const left = Math.max(0, lastInput + CALM_AFTER_MS - Date.now());
  timer = setTimeout(() => {
    timer = null;
    evaluate();
    // input arrived since the timer was armed: check again at its deadline
    if (Date.now() - lastInput < CALM_AFTER_MS) arm();
  }, left + 50);
}

function onInput(): void {
  lastInput = Date.now();
  focused = true;
  if (document.documentElement.hasAttribute('data-calm')) evaluate();
  arm();
}

let started = false;

/** Called once from main.tsx. */
export function startCalm(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  focused = document.hasFocus();
  const opts = { capture: true, passive: true } as const;
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(ev, onInput, opts);
  }
  window.addEventListener('focus', () => {
    focused = true;
    onInput();
  });
  window.addEventListener('blur', () => {
    focused = false;
    evaluate();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onInput();
    else evaluate();
  });
  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (mq) {
    reduced = mq.matches;
    mq.addEventListener?.('change', (e) => {
      reduced = e.matches;
      evaluate();
    });
  }
  evaluate();
  arm();
}
