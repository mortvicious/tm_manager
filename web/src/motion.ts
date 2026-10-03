/**
 * Motion helpers for the Glass design (docs/glass.md § Motion). Classic never
 * sees any of this: every effect is gated on `html[data-design='glass']`.
 */

function glassMotion() {
  return (
    document.documentElement.dataset.design === 'glass' &&
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * A ref callback that plays an overlay's exit animation after React has
 * removed it: `<div className="slideover" ref={exitGhost}>`. Parents mount
 * overlays conditionally (`{open && <Sheet/>}`), so a component never gets to
 * delay its own unmount. Instead its last frame is cloned in place, tagged
 * `tm-exit` (glass.css animates that), and removed once its animations end.
 *
 * Module-level on purpose: a stable callback identity means React only calls
 * the cleanup on a real detach, not on every render. The clone is inert (no
 * React, no handlers, aria-hidden, no ids). cloneNode keeps field values;
 * scroll offsets it drops, so those are copied over.
 */
export function exitGhost(node: HTMLElement | null) {
  if (!node) return;
  return () => {
    // React detaches refs before it removes the DOM, so the node still holds
    // its last frame here. Clone NOW: passive-effect cleanups (an xterm
    // dispose) may strip its DOM before the microtask below runs.
    if (!glassMotion()) return;
    const parent = node.parentNode;
    const next = node.nextSibling;
    const ghost = node.cloneNode(true) as HTMLElement;
    const scrolls: [number, number][] = [];
    node.querySelectorAll<HTMLElement>('*').forEach((el, i) => {
      if (el.scrollTop > 0) scrolls.push([i, el.scrollTop]);
    });
    const top = node.scrollTop;
    // StrictMode's dev double-invoke runs this WITHOUT removing the node:
    // decide after the commit, once a real unmount has detached it.
    queueMicrotask(() => {
      if (node.isConnected || !parent || !parent.isConnected) return;
      ghost.classList.add('tm-exit');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      // the ids belong to whatever replaces the overlay: getElementById must never find a ghost
      ghost.removeAttribute('id');
      ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      parent.insertBefore(ghost, next && next.parentNode === parent ? next : null);
      const done = () => ghost.remove();
      // armed before anything that could throw: the ghost always goes
      const backstop = setTimeout(done, 900);
      const finish = () => {
        clearTimeout(backstop);
        done();
      };
      try {
        const copies = ghost.querySelectorAll<HTMLElement>('*');
        for (const [i, t] of scrolls) if (copies[i]) copies[i].scrollTop = t;
        ghost.scrollTop = top;
        const anims = ghost.getAnimations?.({ subtree: true }) ?? [];
        if (anims.length === 0) finish();
        else void Promise.allSettled(anims.map((a) => a.finished)).then(finish);
      } catch {
        finish();
      }
    });
  };
}

/**
 * iOS Safari only applies `:active` under a touch listener. React already
 * listens on its roots, so this covers whatever sits outside them.
 */
export function installTouchActive() {
  document.addEventListener('touchstart', () => {}, { passive: true });
}
