/**
 * Event bus + replay ring.
 *
 * - publish(): adds to ring, fans out to live subscribers
 * - subscribe(): returns an iterator-like handle; subscriber receives events
 *   matching its filter via `onEvent` callback
 * - replaySince(): returns events newer than a given timestamp / id, filtered
 *
 * Memory only for v0 — pinned to the lifetime of the MCP process. M9.x can
 * back this with the WS bridge to a durable event store on the platform.
 */
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import {
  EventKind, EventCorrelation, McpEventEnvelope, SubscriptionFilter, matchesFilter,
} from "./types";

const RING_CAP = 5_000;

class EventBus {
  private ring: McpEventEnvelope[] = [];
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(input: {
    kind: EventKind;
    correlation: EventCorrelation;
    severity?: "info" | "warn" | "error";
    payload?: Record<string, unknown>;
  }): McpEventEnvelope {
    const ev: McpEventEnvelope = {
      id: uuidv4(),
      kind: input.kind,
      timestamp: new Date().toISOString(),
      correlation: input.correlation,
      severity: input.severity ?? "info",
      payload: input.payload ?? {},
    };
    this.ring.push(ev);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    this.emitter.emit("event", ev);
    return ev;
  }

  /** Returns an unsubscribe function. */
  subscribe(filter: SubscriptionFilter | undefined, onEvent: (ev: McpEventEnvelope) => void): () => void {
    const handler = (ev: McpEventEnvelope) => {
      if (matchesFilter(ev, filter)) onEvent(ev);
    };
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  /** Replay events from the ring matching the filter. */
  replaySince(opts: {
    since_id?: string;
    since_timestamp?: string;
    filter?: SubscriptionFilter;
    limit?: number;
  }): McpEventEnvelope[] {
    const { since_id, since_timestamp, filter, limit = 500 } = opts;
    let cursor = 0;
    if (since_id) {
      const idx = this.ring.findIndex((e) => e.id === since_id);
      cursor = idx === -1 ? 0 : idx + 1;
    } else if (since_timestamp) {
      cursor = this.ring.findIndex((e) => e.timestamp > since_timestamp);
      if (cursor === -1) cursor = this.ring.length;
    }
    const window = this.ring.slice(cursor);
    const matched = window.filter((e) => matchesFilter(e, filter));
    return matched.slice(0, limit);
  }

  /** Recent events for the HTTP poll fallback. */
  recent(filter?: SubscriptionFilter, limit = 200): McpEventEnvelope[] {
    return this.ring.filter((e) => matchesFilter(e, filter)).slice(-limit).reverse();
  }
}

export const events = new EventBus();
