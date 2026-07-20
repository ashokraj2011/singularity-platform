/**
 * Central LLM gateway client (M33 invariant): all LLM work goes through the gateway
 * BY MODEL ALIAS. This service holds no provider credentials — only LLM_GATEWAY_URL +
 * a model alias cross the boundary. Injectable so the lowering service unit-tests
 * with a fake (no network).
 */
export interface GatewayLlm {
  complete(input: {
    system: string;
    task: string;
    traceId: string;
    modelAlias?: string;
    /** Who this lowering pass is for. `system:claim-registry` when the event
     *  had no capturer. Never null — null means "somebody forgot". */
    actorId?: string;
    /** Real, not defaulted: claim-registry is genuinely tenant-scoped
     *  (currentRegistryTenant()), so this is one of the few call sites that
     *  can honestly send a tenant. */
    tenantId?: string;
  }): Promise<string>;
}

export const defaultGatewayLlm: GatewayLlm = {
  async complete({ system, task, traceId, modelAlias, actorId, tenantId }) {
    const base = process.env.LLM_GATEWAY_URL;
    if (!base) throw new Error('LLM_GATEWAY_URL is not set (M33: LLM work must route through the gateway)');
    const res = await fetch(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace-id': traceId },
      body: JSON.stringify({
        model_alias: modelAlias ?? process.env.LOWERING_MODEL_ALIAS ?? 'default',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: task },
        ],
        temperature: 0.2,
        // Infrastructure call: composer/CF-exempt by the split rule, but bound
        // to the gateway and tagged so lowering spend is attributable.
        task_tag: 'claim_lowering',
        trace_id: traceId,
        // Tagged since W2-1, but still anonymous: "what did lowering cost" was
        // answerable, "for whom" was not.
        actor_id: actorId ?? 'system:claim-registry',
        ...(tenantId ? { tenant_id: tenantId } : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM gateway returned ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  },
};
