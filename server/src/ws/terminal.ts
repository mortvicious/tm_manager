import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { TerminalClientMsg } from '@tm/shared';
import { sessionToken } from '../auth.ts';
import type { SessionManager } from '../pty/session-manager.ts';

/** Origin must be a loopback page: the app itself (any port — dev server included). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false; // browsers always send Origin on WS upgrades
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * @param managers every PTY pool that can own a session id — the orchestrator's
 * agent sessions and the repo-command sessions (docs/commands.md). Ids are
 * unique across pools (commands are `cmd-`-prefixed), so the first pool that
 * knows the id owns the socket for its whole lifetime.
 */
export function registerTerminalWs(app: FastifyInstance, managers: SessionManager[]) {
  app.get('/ws/terminal/:runId', { websocket: true }, (socket: WebSocket, req) => {
    const { runId } = req.params as { runId: string };
    const { token } = req.query as { token?: string };

    // The terminal is a code-execution surface: Origin + per-boot token, both.
    if (!isAllowedOrigin(req.headers.origin) || token !== sessionToken) {
      socket.close(4403, 'forbidden');
      return;
    }

    const sessions = managers.find((m) => m.get(runId) !== undefined);
    if (!sessions || !sessions.attach(runId, socket)) {
      socket.close(4404, 'no such session');
      return;
    }

    socket.on('message', (raw: Buffer) => {
      let msg: TerminalClientMsg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        try {
          sessions.input(runId, Buffer.from(msg.data, 'base64'));
        } catch {
          // bad base64 — drop
        }
      } else if (msg.type === 'resize') {
        sessions.resize(runId, msg.cols, msg.rows);
      }
    });
  });
}
