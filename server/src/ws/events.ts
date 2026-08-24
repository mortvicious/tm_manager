import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { sessionToken } from '../auth.ts';
import { onEvent } from '../events.ts';
import { isAllowedOrigin } from './terminal.ts';

export function registerEventsWs(app: FastifyInstance) {
  app.get('/ws/events', { websocket: true }, (socket: WebSocket, req) => {
    const { token } = req.query as { token?: string };
    // Same posture as the terminal WS: any local page could otherwise
    // subscribe to task titles/status (review F6).
    if (!isAllowedOrigin(req.headers.origin) || token !== sessionToken) {
      socket.close(4403, 'forbidden');
      return;
    }
    const off = onEvent((e) => {
      if (socket.readyState === socket.OPEN) {
        try {
          socket.send(JSON.stringify(e));
        } catch {
          // dead socket; close handler cleans up
        }
      }
    });
    socket.on('close', off);
  });
}
