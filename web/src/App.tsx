import { useCallback, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { TaskSlideOver } from './components/TaskSlideOver.tsx';
import { TerminalDrawer } from './components/TerminalDrawer.tsx';
import { BoardPage } from './pages/Board.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { FeaturePage } from './pages/Feature.tsx';
import { FeaturesPage } from './pages/Features.tsx';
import { ConfigPage } from './pages/Config.tsx';
import { HandbookPage } from './pages/Handbook.tsx';
import { QueuePage } from './pages/Queue.tsx';
import { ReposPage } from './pages/Repos.tsx';

export function App() {
  const [openTask, setOpenTask] = useState<string | null>(null);
  // nonce so re-opening the already-open terminal still re-expands a compacted drawer
  const [openTerminal, setOpenTerminal] = useState<{ runId: string; nonce: number } | null>(null);
  const openTerm = useCallback(
    (runId: string) => setOpenTerminal((cur) => ({ runId, nonce: (cur?.nonce ?? 0) + 1 })),
    [],
  );

  return (
    <Layout onOpenTerminal={openTerm}>
      <Routes>
        <Route path="/" element={<DashboardPage onOpenTask={setOpenTask} />} />
        <Route path="/board" element={<BoardPage onOpenTask={setOpenTask} onOpenTerminal={openTerm} />} />
        <Route path="/queue" element={<QueuePage onOpenTask={setOpenTask} onOpenTerminal={openTerm} />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/features/:id" element={<FeaturePage onOpenTask={setOpenTask} />} />
        <Route path="/repos" element={<ReposPage onOpenTerminal={openTerm} />} />
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/handbook" element={<HandbookPage />} />
      </Routes>
      {openTask && (
        <TaskSlideOver
          taskId={openTask}
          onOpenTask={setOpenTask}
          onClose={() => setOpenTask(null)}
          onOpenTerminal={(runId) => {
            // Slide-over closes: its overlay sits above the terminal drawer (review R7).
            setOpenTask(null);
            openTerm(runId);
          }}
        />
      )}
      {openTerminal && (
        <TerminalDrawer
          runId={openTerminal.runId}
          expandSignal={openTerminal.nonce}
          onClose={() => setOpenTerminal(null)}
        />
      )}
    </Layout>
  );
}
