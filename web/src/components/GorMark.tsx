import { useId } from 'react';

/**
 * The Gor mark (docs/magma.md § 10): a rounded tile, a single-stroke G in the
 * ember gradient and one spark. Inline SVG so it is never a network request;
 * always decorative (`aria-hidden`) — the surrounding block carries the name.
 *
 * The colours are the mark's own literals, the same as the SVG master
 * (web/public/gor-mark.svg) and the icon exports: a logo is an asset, not a
 * themed surface, so it reads the same in Classic, Glass and Magma.
 *
 * The gradient id is per instance (`useId`): the sidebar and the phone title
 * can both be mounted, and a `url(#id)` that resolves to a copy inside a
 * `display: none` subtree paints nothing in Chromium.
 */
export function GorMark({ size = 24, className }: { size?: number; className?: string }) {
  const id = `gor-ember-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      className={className ? `gor-mark ${className}` : 'gor-mark'}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="14" y1="50" x2="50" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff4a3d" />
          <stop offset=".6" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#ffc93d" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#0a0605" />
      <path
        d="M44.73 19.27A18 18 0 1 0 50 32H34"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* ≤ 18 px the spark moves out of the stroke's end (§ 10 Small sizes) */}
      {size <= 18 ? <circle cx="54" cy="10" r="5" fill="#ffc93d" /> : <circle cx="49" cy="14" r="4.5" fill="#ffc93d" />}
    </svg>
  );
}
