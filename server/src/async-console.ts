// Side-effect module: the FIRST import of index.ts, so every module's
// top-level and later console.* calls write asynchronously (logging.ts,
// docs/host.md § Logging). ESM evaluates imports in order.
import { installAsyncConsole } from './logging.ts';

installAsyncConsole();
