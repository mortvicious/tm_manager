import { Suspense } from 'react';
import { useBoardVersion, type BoardVersionProps } from '../boardVersions.ts';
import { BoardJobs } from '../components/BoardJobs.tsx';
import { BoardVersionsControl } from '../components/BoardVersions.tsx';
import { BoardPage } from './Board.tsx';

/**
 * The /board route (docs/board-versions.md § Versions control): the frozen
 * original Board for `original`, the device's chosen version otherwise. Deep
 * links need nothing here — `?task=`/`?tab=` are App's and `?ws=` is
 * useWorkspace()'s, so they behave the same in every version. Scheduled jobs
 * ride above every version as tiny rows (BoardJobs) — never inside the frozen
 * BoardPage.
 */
export function BoardRoute(props: BoardVersionProps) {
  const version = useBoardVersion();
  const Version = version.component;
  if (!Version)
    return (
      <>
        <BoardJobs />
        <BoardPage {...props} headSlot={<BoardVersionsControl />} />
      </>
    );
  return (
    <>
      <BoardJobs />
      <Suspense fallback={<div className="board" aria-busy="true" />}>
        <Version {...props} />
      </Suspense>
    </>
  );
}
