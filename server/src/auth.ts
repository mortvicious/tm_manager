import { randomBytes } from 'node:crypto';

// Per-boot secret. Internal hook callbacks and terminal WS attaches must
// present it. Lives in its own module so pty/orchestrator/ws code can import
// it without cycling through index.ts.
export const sessionToken = randomBytes(24).toString('hex');
