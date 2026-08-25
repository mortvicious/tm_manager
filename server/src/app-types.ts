import type { Task } from '@tm/shared';

export type ActionResult = { task: Task } | { error: string; code: number };

export interface OrchestratorApi {
  maybeSchedule(): void;
  runNow(taskId: string, actor?: string): Promise<ActionResult>;
  cancel(taskId: string, actor?: string): Promise<ActionResult>;
  followUp(
    taskId: string,
    message: string,
    actor?: string,
    mode?: 'auto' | 'resume' | 'fresh',
  ): Promise<ActionResult>;
  /** Reopen the task's previous claude session and carry on ("proceed"). */
  proceed(taskId: string, message?: string | null, actor?: string): Promise<ActionResult>;
  /** Session id "proceed" would continue, or null when there is none. */
  resumableSessionId(taskId: string): Promise<string | null>;
  /** Re-evaluate a task's dependents after it reached a terminal status: its
   *  split parent AND, when it belongs to one, its feature's phase gate. */
  resolveCompletion(child: Task, actor?: string): Promise<void>;
  /** Feature phase pump: enqueue the current phase, pause on failure, or roll
   *  up to review. Also called directly by the start/resume routes. */
  advanceFeature(featureId: string, actor?: string): Promise<void>;
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
