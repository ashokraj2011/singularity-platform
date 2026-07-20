/**
 * Central LLM gateway client (M33 invariant): all LLM work goes through the gateway.
 * This service holds no provider credentials — only LLM_GATEWAY_URL and, optionally,
 * a model alias cross the boundary. Injectable so the lowering service unit-tests
 * with a fake (no network).
 *
 * TWO BUGS LIVED HERE, and together they meant claim lowering had never once
 * worked against a live gateway:
 *
 *   1. The alias fell back to the literal string 'default'. There is no catalog
 *      entry named "default" — `resolve_alias` would raise and the gateway would
 *      answer 400. So an unconfigured deployment did not get a default model, it
 *      got a hard failure.
 *   2. The response was read as `data.choices[0].message.content`, the OpenAI
 *      envelope. This gateway returns `content` at the TOP LEVEL (see
 *      llm_gateway_service/app/types.py ChatCompletionResponse). The optional
 *      chaining meant that on the happy path — a 200 with a real completion —
 *      `complete()` returned '' rather than throwing.
 *
 * The second is the worse one: '' is a value, not an error. Lowering treated an
 * empty canonicalization as a legitimate answer, so a failure that should have
 * been loud became a silent quality hole. The parse is now strict — a response
 * without usable content raises.
 */
export interface GatewayLlm {
  complete(input: { system: string; task: string; traceId: string; modelAlias?: string }): Promise<string>;
}

export const defaultGatewayLlm: GatewayLlm = {
  async complete({ system, task, traceId, modelAlias }) {
    const base = process.env.LLM_GATEWAY_URL;
    if (!base) throw new Error('LLM_GATEWAY_URL is not set (M33: LLM work must route through the gateway)');
    // An explicit alias still pins. Unpinned, we send NO alias and let
    // `task_tag: claim_lowering` route it — which is a real routing decision,
    // where 'default' was a guaranteed 400 dressed up as a fallback.
    const alias = (modelAlias ?? process.env.LOWERING_MODEL_ALIAS ?? '').trim();
    const res = await fetch(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace-id': traceId },
      body: JSON.stringify({
        ...(alias ? { model_alias: alias } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: task },
        ],
        temperature: 0.2,
        // Infrastructure call: composer/CF-exempt by the split rule, but bound
        // to the gateway and tagged so lowering spend is attributable — and, now
        // that no alias is sent by default, so it is ROUTABLE.
        task_tag: 'claim_lowering',
        trace_id: traceId,
      }),
    });
    if (!res.ok) throw new Error(`LLM gateway returned ${res.status}`);
    const data = (await res.json()) as { content?: unknown };
    if (typeof data.content !== 'string' || !data.content) {
      // Deliberately a throw. Returning '' here is what hid this bug for its
      // entire life: the caller cannot tell "the model said nothing" from
      // "we read the wrong field of a perfectly good response".
      throw new Error('LLM gateway response had no usable `content` field');
    }
    return data.content;
  },
};
