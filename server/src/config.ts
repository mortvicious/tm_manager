import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BootConfig {
  port: number;
  storage: {
    driver: 'sqlite' | 'postgres';
    sqlite: { file: string };
    postgres: { connectionString: string };
  };
}

const DEFAULT_CONFIG: BootConfig = {
  port: 5175,
  storage: {
    driver: 'sqlite',
    sqlite: { file: 'data/taskman.db' },
    postgres: { connectionString: '' },
  },
};

export const serverRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
export const dataDir = path.join(serverRoot, 'data');
/** Per-task deliverable files: artifacts/<taskId>/ — exposed in the task drawer. */
export const artifactsRoot = path.join(dataDir, 'artifacts');
const configPath = path.join(dataDir, 'config.json');

export function loadBootConfig(): BootConfig {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`data/config.json is not valid JSON: ${(e as Error).message}`);
  }
  const driver = raw.storage?.driver ?? 'sqlite';
  if (driver !== 'sqlite' && driver !== 'postgres') {
    throw new Error(`data/config.json: storage.driver must be "sqlite" or "postgres", got "${driver}"`);
  }
  if (raw.port !== undefined && !(Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536)) {
    throw new Error(`data/config.json: port must be an integer in 1..65535`);
  }
  // Shallow-merge so new fields get defaults when the file predates them.
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...raw,
    storage: {
      ...structuredClone(DEFAULT_CONFIG.storage),
      ...(raw.storage ?? {}),
      sqlite: { ...DEFAULT_CONFIG.storage.sqlite, ...(raw.storage?.sqlite ?? {}) },
      postgres: { ...DEFAULT_CONFIG.storage.postgres, ...(raw.storage?.postgres ?? {}) },
    },
  };
}

export function expandHome(p: string): string {
  const home = process.env.HOME;
  if ((p === '~' || p.startsWith('~/')) && !home) {
    throw new Error('cannot expand ~: HOME is not set');
  }
  if (p === '~') return home!;
  if (p.startsWith('~/')) return path.join(home!, p.slice(2));
  if (!path.isAbsolute(p)) {
    // cwd differs between `npm run dev -w server` and `npm start`; relative
    // repo paths would resolve inconsistently, so refuse them.
    throw new Error(`repo path must be absolute or ~-prefixed: ${p}`);
  }
  return path.resolve(p);
}
