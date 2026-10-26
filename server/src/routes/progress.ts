import type { FastifyInstance } from 'fastify';
import { progressBaselineCached } from '../progress.ts';
import type { Storage } from '../storage/types.ts';

/** The board's progress % baseline (docs/task-progress.md); read-only, cached hourly. */
export function registerProgressRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/progress/baseline', async () => progressBaselineCached(storage));
}
