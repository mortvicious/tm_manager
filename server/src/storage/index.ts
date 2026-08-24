import path from 'node:path';
import type { BootConfig } from '../config.ts';
import { serverRoot } from '../config.ts';
import { SqliteStorage } from './sqlite.ts';
import type { Storage } from './types.ts';

export async function createStorage(cfg: BootConfig): Promise<Storage> {
  let storage: Storage;
  if (cfg.storage.driver === 'postgres') {
    const { PostgresStorage } = await import('./postgres.ts');
    storage = new PostgresStorage(cfg.storage.postgres.connectionString);
  } else {
    storage = new SqliteStorage(path.resolve(serverRoot, cfg.storage.sqlite.file));
  }
  await storage.migrate();
  return storage;
}
