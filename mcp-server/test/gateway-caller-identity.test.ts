/**
 * Caller identity across the mcp-server gateway hop.
 *
 * mcp-server has always carried a full CorrelationIds through its OWN audit
 * store — tenant, session, agent, capability. The identity simply stopped at
 * this boundary, so the platform's busiest LLM path produced gateway cost rows
 * with no owner on them.
 *
 * The honest gap this pins: /mcp/invoke's runContext had no user/actor field at
 * ALL, so `actor_id` is wired but will stay absent until an upstream caller
 * (workgraph-api / context-fabric) starts sending userId. It is deliberately NOT
 * defaulted to "system:mcp-server" — these are relayed agent turns that normally
 * DO have a human behind them, and claiming otherwise would be a false negative
 * on "was a person involved" rather than an admitted unknown.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("the gateway request carries identity", () => {
  it("declares the identity fields on the wire type", () => {
    const types = read("src/llm/types.ts");
    for (const field of ["actor_id?: string", "tenant_id?: string", "session_id?: string"]) {
      expect(types, `LlmRequest is missing ${field}`).toContain(field);
    }
  });

  it("forwards them from LlmRequest onto the gateway body", () => {
    const client = read("src/llm/client.ts");
    // Conditional spreads, not bare assignment: an unresolved field must be
    // ABSENT, because `actor_id: null` reads as "no human" when it means
    // "nobody propagated one".
    for (const field of ["actor_id", "tenant_id", "session_id"]) {
      expect(client).toContain(`...(req.${field} ? { ${field}: req.${field} } : {})`);
    }
  });

  it("keeps the agent_turn tag it already sent", () => {
    // Everything reaching the gateway through mcp-server is an agent turn by
    // construction; identity is additive and must not disturb that.
    expect(read("src/llm/client.ts")).toContain('task_tag: "agent_turn"');
  });

  it("never writes a null actor", () => {
    const client = read("src/llm/client.ts");
    expect(client).not.toContain("actor_id: null");
    expect(client).not.toContain("actor_id: undefined");
  });
});

describe("identity comes from the invocation's correlation", () => {
  it("accepts a userId on the /mcp/invoke runContext", () => {
    // The field did not exist before, so anything a caller sent was stripped by
    // Zod and the gateway could never learn who the turn was for.
    const invoke = read("src/mcp/invoke.ts");
    const schema = invoke.slice(invoke.indexOf("runContext: z.object({"));
    const runContextBlock = schema.slice(0, schema.indexOf("}).default({})"));
    expect(runContextBlock).toContain("userId: z.string().optional()");
  });

  it("carries userId through CorrelationIds", () => {
    expect(read("src/audit/store.ts")).toMatch(/interface CorrelationIds \{[\s\S]{0,300}userId\?: string/);
  });

  it("maps correlation onto the gateway's field names", () => {
    const invoke = read("src/mcp/invoke.ts");
    expect(invoke).toContain("function gatewayIdentityFrom(correlation: CorrelationIds)");
    expect(invoke).toContain("actor_id: correlation.userId");
    expect(invoke).toContain("tenant_id: correlation.tenantId");
    expect(invoke).toContain("session_id: correlation.sessionId");
  });

  it("does not fake a system actor for relayed human turns", () => {
    // The gap is real and should stay visible. A "system:mcp-server" default
    // would make every user-launched run look like background work — a wrong
    // answer dressed as a complete one.
    const invoke = read("src/mcp/invoke.ts");
    expect(invoke).not.toContain('actor_id: "system:mcp-server"');
    expect(invoke).not.toContain('correlation.userId ?? "system:');
  });

  it("applies identity at EVERY llmRespond call, not just the main loop", () => {
    // The applier and the two finalization turns are separate gateway calls.
    // Tagging only the obvious one leaves real spend unattributed while looking
    // done — the exact failure this whole change exists to remove.
    const invoke = read("src/mcp/invoke.ts");
    const callCount = (invoke.match(/await llmRespond\(\{/g) ?? []).length;
    const identityCount = (invoke.match(/\.\.\.gatewayIdentityFrom\(state\.correlation\)/g) ?? []).length;
    expect(callCount).toBeGreaterThan(0);
    expect(identityCount, "every llmRespond call site should pass identity").toBe(callCount);
  });
});
