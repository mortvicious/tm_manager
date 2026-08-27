import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BootConfig {
  port: number;
  /**
   * The front door (docs/host.md): a separate process that serves the built
   * SPA and reverse-proxies /api and /ws to `port`, so the page outlives the
   * API it talks to. Distinct from `port` on purpose — the API keeps the port
   * every hook, worker env and `TM_CALLBACK_URL` already points at.
   */
  host: { port: number };
  /**
   * LAN mode: bind every interface so a phone on the same Wi-Fi can open the
   * board (docs/mobile.md). OFF by default — the terminal WS is a
   * code-execution surface and anyone who can reach /api/session gets it.
   * `TM_LAN=1` in the environment forces it on without editing this file.
   */
  lan: { enabled: boolean };
  storage: {
    driver: 'sqlite' | 'postgres';
    sqlite: { file: string };
    postgres: { connectionString: string };
  };
}

const DEFAULT_CONFIG: BootConfig = {
  port: 5175,
  host: { port: 5176 },
  lan: { enabled: false },
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
  if (raw.lan?.enabled !== undefined && typeof raw.lan.enabled !== 'boolean') {
    throw new Error(`data/config.json: lan.enabled must be a boolean`);
  }
  if (raw.host?.port !== undefined && !(Number.isInteger(raw.host.port) && raw.host.port > 0 && raw.host.port < 65536)) {
    throw new Error(`data/config.json: host.port must be an integer in 1..65535`);
  }
  // TM_HOST_PORT exists so an isolated copy (and the tests that drive one) can
  // move the front door without editing the file the real install shares.
  const hostPortEnv = process.env.TM_HOST_PORT;
  if (hostPortEnv !== undefined && !/^\d+$/.test(hostPortEnv)) {
    throw new Error(`TM_HOST_PORT must be an integer in 1..65535, got "${hostPortEnv}"`);
  }
  const hostPort = hostPortEnv !== undefined ? Number(hostPortEnv) : (raw.host?.port ?? DEFAULT_CONFIG.host.port);
  if (!(Number.isInteger(hostPort) && hostPort > 0 && hostPort < 65536)) {
    throw new Error(`host port must be an integer in 1..65535, got ${hostPort}`);
  }
  // Shallow-merge so new fields get defaults when the file predates them.
  // The env var can only turn LAN mode ON — `npm run dev:lan` should not need
  // the config file edited, but nothing in the environment may silently
  // disable a setting the file asked for.
  const lanEnabled = raw.lan?.enabled === true || process.env.TM_LAN === '1';
  const port = raw.port ?? DEFAULT_CONFIG.port;
  if (hostPort === port) {
    throw new Error(`host.port (${hostPort}) must differ from the API port (${port})`);
  }
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...raw,
    host: { port: hostPort },
    lan: { enabled: lanEnabled },
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
