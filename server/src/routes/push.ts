import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_PUSH_KINDS, PUSH_KINDS, type PushKind } from '@tm/shared';
import { publicDevice, type PushService } from '../push/service.ts';
import { endpointAllowed } from '../push/webpush.ts';
import type { Storage } from '../storage/types.ts';

// docs/push.md — the SPA's side of Web Push. Every write is the human's: a
// worker knows $TM_CALLBACK_URL and could otherwise subscribe an endpoint of
// its choosing (curl sends no Origin; a browser always does on a POST).

const kindSchema = z.enum(PUSH_KINDS.map((k) => k.kind) as [PushKind, ...PushKind[]]);
const b64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).max(200);

const subscribeSchema = z
  .object({
    /** PushSubscription.toJSON(); expirationTime is ignored */
    subscription: z.object({
      endpoint: z.string().url().max(1024),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: b64url, auth: b64url }),
    }),
    label: z.string().trim().min(1).max(60).optional(),
    /** absent = keep what this endpoint had, or the defaults for a new one */
    kinds: z.array(kindSchema).max(PUSH_KINDS.length).optional(),
    /** the endpoint this one replaces (pushsubscriptionchange): its label and kinds carry over */
    replaces: z.string().max(1024).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    kinds: z.array(kindSchema).max(PUSH_KINDS.length).optional(),
  })
  .strict();

function fromBrowser(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers.origin) return true;
  void reply.code(403).send({ error: 'push devices are managed from the browser, not from a script' });
  return false;
}

export function registerPushRoutes(app: FastifyInstance, storage: Storage, push: PushService) {
  app.get('/api/push', async () => push.status());

  app.post('/api/push/devices', async (req, reply) => {
    if (!fromBrowser(req, reply)) return;
    if (!push.enabled) return reply.code(409).send({ error: 'push is disabled (push.enabled in data/config.json)' });
    const body = subscribeSchema.parse(req.body);
    const { endpoint, keys } = body.subscription;
    if (!endpointAllowed(endpoint)) {
      return reply.code(400).send({ error: 'endpoint is not a known browser push service' });
    }
    const devices = await storage.listPushDevices();
    const existing = devices.find((d) => d.endpoint === endpoint);
    const replaced = body.replaces && body.replaces !== endpoint ? devices.find((d) => d.endpoint === body.replaces) : undefined;
    const prior = existing ?? replaced;
    const device = await storage.upsertPushDevice({
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      label: body.label ?? prior?.label ?? 'Device',
      kinds: dedupe(body.kinds ?? prior?.kinds ?? DEFAULT_PUSH_KINDS),
    });
    if (replaced) await storage.deletePushDevice(replaced.id);
    return publicDevice(device);
  });

  app.patch('/api/push/devices/:id', async (req, reply) => {
    if (!fromBrowser(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const d = await storage.updatePushDevice(id, { label: body.label, kinds: body.kinds && dedupe(body.kinds) });
    if (!d) return reply.code(404).send({ error: 'no such device' });
    return publicDevice(d);
  });

  app.delete('/api/push/devices/:id', async (req, reply) => {
    if (!fromBrowser(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!(await storage.deletePushDevice(id))) return reply.code(404).send({ error: 'no such device' });
    return { ok: true };
  });

  app.post('/api/push/devices/:id/test', async (req, reply) => {
    if (!fromBrowser(req, reply)) return;
    const { id } = req.params as { id: string };
    const r = await push.test(id);
    if (!r) return reply.code(404).send({ error: 'no such device (the push service may have dropped it)' });
    return r;
  });
}

function dedupe(kinds: PushKind[]): PushKind[] {
  return [...new Set(kinds)];
}
