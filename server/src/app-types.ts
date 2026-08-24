import type { Task } from '@tm/shared';

export type ActionResult = { task: Task } | { error: string; code: number };

export interface OrchestratorApi {
  maybeSchedule(): void;
  runNow(taskId: string, actor?: string): Promise<ActionResult>;
  cancel(taskId: string, actor?: string): Promise<ActionResult>;
  followUp(taskId: string, message: string, actor?: string): Promise<ActionResult>;
  /** Re-evaluate the parent after a child reached a terminal status. */
  resolveParent(child: Task, actor?: string): Promise<void>;
  reviewCompletedRun(taskId: string): Promise<void>;
  applyReviewFixes(taskId: string, actor?: string): Promise<ActionResult>;
  /** True when a PTY for this task is still alive (live or idle post-Stop). */
  hasLiveSession(taskId: string): Promise<boolean>;
  /** Kill every live session of a task (used when completing it); returns count closed. */
  closeTaskSessions(taskId: string, actor?: string): Promise<number>;
}

declare module 'fastify' {
  interface FastifyInstance {
    orchestrator?: OrchestratorApi;
  }
}
