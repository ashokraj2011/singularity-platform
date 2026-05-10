/**
 * M11.e — tool-service subscription registry routes.
 */
import { Router } from "express";
import { z } from "zod";
import { pool } from "../../database";

const createSchema = z.object({
  subscriberId: z.string().min(1),
  eventPattern: z.string().min(1),
  targetUrl:    z.string().url(),
  secret:       z.string().optional(),
  metadata:     z.record(z.string(), z.unknown()).optional(),
});

export const eventSubscriptionsRouter = Router();

eventSubscriptionsRouter.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO agent.event_subscriptions (subscriber_id, event_pattern, target_url, secret, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [body.subscriberId, body.eventPattern, body.targetUrl, body.secret ?? null, body.metadata ?? {}],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

eventSubscriptionsRouter.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM agent.event_subscriptions ORDER BY created_at DESC`);
    res.json({ items: rows, total: rows.length });
  } catch (err) { next(err); }
});

eventSubscriptionsRouter.delete("/:id", async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM agent.event_subscriptions WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});
