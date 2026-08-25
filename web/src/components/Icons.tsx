// Minimal 15px stroke icons — one visual voice, no icon library.
const p = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export const IconBoard = () => (
  <svg {...p}>
    <rect x="3" y="3" width="7" height="18" rx="1.5" />
    <rect x="14" y="3" width="7" height="11" rx="1.5" />
  </svg>
);

export const IconQueue = () => (
  <svg {...p}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </svg>
);

export const IconRepo = () => (
  <svg {...p}>
    <path d="M3 7l4-4h10l4 4v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M3 7h18" />
  </svg>
);

export const IconConfig = () => (
  <svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" />
  </svg>
);

export const IconTerminal = () => (
  <svg {...p}>
    <path d="M4 17l6-5-6-5M12 19h8" />
  </svg>
);

export const IconPlay = () => (
  <svg {...p}>
    <path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconStop = () => (
  <svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCheck = () => (
  <svg {...p}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export const IconX = () => (
  <svg {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export const IconAnalyze = () => (
  <svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.5-4.5M8 11h6M11 8v6" />
  </svg>
);

export const IconFeature = () => (
  <svg {...p}>
    <path d="M3 6.5h5.5M3 12h5.5M3 17.5h5.5" />
    <rect x="12.5" y="3.5" width="8" height="6" rx="1.5" />
    <rect x="12.5" y="14.5" width="8" height="6" rx="1.5" />
  </svg>
);

export const IconBook = () => (
  <svg {...p}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z" />
    <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
  </svg>
);

export const IconSun = () => (
  <svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
  </svg>
);

export const IconMoon = () => (
  <svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
  </svg>
);
