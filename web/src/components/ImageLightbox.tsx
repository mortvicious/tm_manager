// Full-screen image viewer for a task's files (docs/handbook.md § Follow-ups &
// files): swipe / arrows between the task's images, pinch or double-tap to
// zoom, a download button for the file itself. yet-another-react-lightbox
// portals to <body> above every sheet and panel; its colours are mapped to
// the --tm-* tokens in theme.css (`.yarl__root`).
import { useEffect } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import { useIsMobile } from './Layout.tsx';

export interface LightboxImage {
  name: string;
  /** rendered in place (`?inline=1`) */
  src: string;
  /** the attachment download */
  download: string;
}

export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: LightboxImage[];
  /** -1 = closed */
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const mobile = useIsMobile();
  const open = index >= 0 && index < images.length;
  const current = open ? images[index] : null;

  // The lightbox stops its own Escape, but a <Sheet> underneath listens on
  // window and skips a defaultPrevented key — mark it first (capture phase),
  // so one Escape closes the viewer and leaves the task panel open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const single = images.length <= 1;
  return (
    <Lightbox
      open={open}
      index={open ? index : 0}
      close={onClose}
      on={{ view: ({ index: i }) => onIndex(i) }}
      slides={images.map((im) => ({ src: im.src, alt: im.name }))}
      plugins={single ? [Zoom] : [Counter, Zoom]}
      carousel={{ finite: single }}
      controller={{ closeOnBackdropClick: true, closeOnPullDown: true }}
      zoom={{ maxZoomPixelRatio: 4, doubleClickMaxStops: 2 }}
      // phones swipe; arrows there only cover the picture
      render={single || mobile ? { buttonPrev: () => null, buttonNext: () => null } : undefined}
      toolbar={{
        buttons: [
          current && (
            <a
              key="download"
              className="yarl__button"
              href={current.download}
              download={current.name}
              title={`Download ${current.name}`}
              aria-label={`Download ${current.name}`}
            >
              <svg className="yarl__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
              </svg>
            </a>
          ),
          'close',
        ],
      }}
      labels={{ Lightbox: current ? current.name : 'Image preview' }}
    />
  );
}
