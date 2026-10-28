import type { FastifyInstance } from 'fastify';
import { scheduleBaselineCached } from '../schedule-baseline.ts';
import type { Storage } from '../storage/types.ts';

/** Worked/review/check duration baseline for schedule ETAs (docs/schedule.md); read-only, cached hourly. */
export function registerScheduleRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/schedule/baseline', async () => scheduleBaselineCached(storage));
}
