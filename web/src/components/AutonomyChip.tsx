// The "autonomous" badge (docs/office.md § Autonomous opt-in): an office task
// whose landing tier the autonomy opt-in raises above supervised — read off
// the server's `OrchestratorStatus.autonomous` (the facts it needs, like the
// shift that filed the task, live only there), or a done/published office
// task the orchestrator auto-landed (an office task cannot auto-land any
// other way). Renders nothing otherwise. Beside RoleChip on TaskRow and in
// the task panel; the frozen board page is not touched.
import type { Task } from '@tm/shared';
import { useApp } from '../state.tsx';

export function AutonomyChip({ task }: { task: Pick<Task, 'id' | 'officeId' | 'status' | 'autoLandedAt'> }) {
  const { orch } = useApp();
  if (!task.officeId) return null;
  const landed = !!task.autoLandedAt && (task.status === 'done' || task.status === 'published');
  const ahead = landed ? null : (orch?.autonomous ?? []).find((t) => t.taskId === task.id);
  if (!landed && !ahead) return null;
  return (
    <span
      className="chip autonomy-chip"
      title={
        landed
          ? 'Landed autonomously: an autonomous office, an opted-in repo, nothing tainted — no human click (the office kill switch takes this away).'
          : `Lands autonomously (${ahead!.landing}): an autonomous office, an opted-in repo, nothing tainted. The office kill switch drops it back to supervised.`
      }
    >
      {landed ? 'landed autonomously' : `autonomous · ${ahead!.landing}`}
    </span>
  );
}
