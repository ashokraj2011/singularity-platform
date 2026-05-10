/**
 * M11.e — agent-runtime subscription registry routes.
 *
 * Subscribers POST {subscriberId, eventPattern, targetUrl, secret?} once;
 * deliveries (with HMAC if `secret` set) flow whenever a matching event
 * lands in `event_outbox`.
 */

import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

const createSchema = z.object({
  subscriberId: z.string().min(1),
  eventPattern: z.string().min(1),
  targetUrl:    z.string().url(),
  secret:       z.string().optional(),
  metadata:     z.record(z.string(), z.unknown()).optional(),
});

export function eventSubscriptionsRouter(prisma: PrismaClient): Router {
  const r = Router();

  r.post("/", async (req, res, next) => {
    try {
      const body = createSchema.parse(req.body);
      const sub = await prisma.eventSubscription.create({
        data: {
          subscriberId: body.subscriberId,
          eventPattern: body.eventPattern,
          targetUrl:    body.targetUrl,
          secret:       body.secret,
          metadata:     body.metadata as object | undefined,
        },
      });
      res.status(201).json(sub);
    } catch (err) { next(err); }
  });

  r.get("/", async (_req, res, next) => {
    try {
      const subs = await prisma.eventSubscription.findMany({ orderBy: { createdAt: "desc" } });
      res.json({ items: subs, total: subs.length });
    } catch (err) { next(err); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      await prisma.eventSubscription.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return r;
}
