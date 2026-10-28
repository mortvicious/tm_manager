import { useCallback, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { WORKSPACE_SLUG_RE, type Task, type Workspace } from '@tm/shared';
import { PANEL_PUSHED } from './nav.ts';
import { useApp } from './state.tsx';
import { toastInfo } from './toast.ts';

/**
 * The current workspace (docs/workspaces.md § Current workspace) IS the URL's
 * `?ws=<slug>`, the way `?task=<id>` is the open panel (App.tsx useOpenTask):
 * no param means All. Every write edits the LIVE URL, so it composes with
 * `?task=` in either order.
 */
export const WS_PARAM = 'ws';

/** this device's last pick, applied only to a bare launch (applyRememberedWorkspace) */
export const WORKSPACE_MEMORY_KEY = 'tm.workspace';

function remembered(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_MEMORY_KEY) || null;
  } catch {
    return null;
  }
}

function remember(slug: string | null): void {
  try {
    if (slug) localStorage.setItem(WORKSPACE_MEMORY_KEY, slug);
    else localStorage.removeItem(WORKSPACE_MEMORY_KEY);
  } catch {
    // private mode: the URL still carries the pick for this session
  }
}

/**
 * The Home Screen launch: `/` or `/board` with an EMPTY query string opens in
 * the remembered workspace. Any other URL without `?ws` means All, so a push
 * tap (`/?task=<id>`) and an old bookmark keep meaning All. Called once from
 * main.tsx before the router reads the URL, so nothing renders unscoped first.
 */
export function applyRememberedWorkspace(): void {
  const { pathname, search, hash } = window.location;
  if (search !== '' || (pathname !== '/' && pathname !== '/board')) return;
  const slug = remembered();
  if (!slug || !WORKSPACE_SLUG_RE.test(slug)) return;
  window.history.replaceState(window.history.state, '', `${pathname}?${WS_PARAM}=${encodeURIComponent(slug)}${hash}`);
}

/** `to` (an in-app path, may carry its own query and hash) in workspace `slug` */
export function withWorkspace(to: string, slug: string | null): string {
  if (!slug) return to;
  const url = new URL(to, window.location.origin);
  url.searchParams.set(WS_PARAM, slug);
  return url.pathname + url.search + url.hash;
}

/**
 * Rewrite `?ws` on the live URL in place. The entry stops being "the one the
 * panel pushed": closing the panel would otherwise go Back to the old scope.
 */
function replaceWorkspaceParam(navigate: NavigateFunction, slug: string | null): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(WS_PARAM) === slug) return;
  if (slug) url.searchParams.set(WS_PARAM, slug);
  else url.searchParams.delete(WS_PARAM);
  const usr = (window.history.state as { usr?: unknown } | null)?.usr;
  let state: unknown = usr;
  if (usr && typeof usr === 'object' && PANEL_PUSHED in usr) {
    const { [PANEL_PUSHED]: _pushed, ...rest } = usr as Record<string, unknown>;
    state = Object.keys(rest).length ? rest : undefined;
  }
  navigate({ pathname: url.pathname, search: url.search, hash: url.hash }, { replace: true, state });
}

export interface WorkspaceScope {
  /** null = All (no param, a slug not loaded yet, or one that no longer exists) */
  workspace: Workspace | null;
  /** the workspace's repos; null = All */
  repoIds: ReadonlySet<string> | null;
  /** a task in scope; repo-less items always are */
  inScope(task: Pick<Task, 'repoId'>): boolean;
  inScopeRepo(repoId: string | null): boolean;
  /** replace `?ws` (null removes it = All) and remember the pick on this device */
  setWorkspace(slug: string | null): void;
  /** an in-app path carrying the current `?ws` */
  wsHref(to: string): string;
}

export function useWorkspace(): WorkspaceScope {
  const { search } = useLocation();
  const navigate = useNavigate();
  const { workspaces } = useApp();
  const slug = new URLSearchParams(search).get(WS_PARAM) || null;
  const workspace = useMemo(
    () => (slug ? (workspaces.find((w) => w.slug === slug) ?? null) : null),
    [slug, workspaces],
  );
  // `repoIds` may name a repo deleted since the list loaded; it matches nothing
  const repoIds = useMemo<ReadonlySet<string> | null>(
    () => (workspace ? new Set(workspace.repoIds) : null),
    [workspace],
  );
  const inScopeRepo = useCallback(
    (repoId: string | null) => repoIds === null || repoId === null || repoIds.has(repoId),
    [repoIds],
  );
  const inScope = useCallback((task: Pick<Task, 'repoId'>) => inScopeRepo(task.repoId), [inScopeRepo]);
  const setWorkspace = useCallback(
    (next: string | null) => {
      remember(next);
      replaceWorkspaceParam(navigate, next);
    },
    [navigate],
  );
  const wsHref = useCallback((to: string) => withWorkspace(to, slug), [slug]);
  return { workspace, repoIds, inScope, inScopeRepo, setWorkspace, wsHref };
}

/**
 * Mounted once (Layout): a `?ws` naming no workspace — deleted here or in
 * another tab, or a stale link — falls back to All with a toast, and forgets
 * the device's memory when it was that slug. Judged only once the list has
 * loaded, so a cold start never mistakes "not heard yet" for "gone".
 */
export function WorkspaceGuard(): null {
  const { workspaces, workspacesLoaded } = useApp();
  const { search } = useLocation();
  const navigate = useNavigate();
  const slug = new URLSearchParams(search).get(WS_PARAM);
  const known = slug !== null && workspaces.some((w) => w.slug === slug);
  useEffect(() => {
    if (slug === null || known || !workspacesLoaded) return;
    if (slug !== '') toastInfo('workspace', `Workspace “${slug}” no longer exists — showing all repos`);
    if (remembered() === slug) remember(null);
    replaceWorkspaceParam(navigate, null);
  }, [slug, known, workspacesLoaded, navigate]);
  return null;
}
