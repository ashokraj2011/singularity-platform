/**
 * Tests for the claim-registry gateway client.
 *
 * These exist because claim lowering had never worked against a live gateway,
 * and nothing caught it. Two independent bugs conspired:
 *
 *   • the model alias fell back to the literal string 'default', which is not a
 *     catalog id, so an unconfigured deployment got a 400 rather than a default;
 *   • the response was read as the OpenAI envelope
 *     (`choices[0].message.content`) while this gateway returns `content` at the
 *     top level, so a perfectly good 200 yielded ''.
 *
 * The second bug was invisible by construction. '' parsed to zero candidates,
 * and zero candidates is a legitimate outcome — the event was marked NO_CLAIMS,
 * a successful-looking terminal state. Every assertion below is therefore about
 * the SHAPE of the request and the STRICTNESS of the parse, not about whether a
 * call succeeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultGatewayLlm } from '../src/lib/gateway';

const originalFetch = globalThis.fetch;
const originalGatewayUrl = process.env.LLM_GATEWAY_URL;
const originalLoweringAlias = process.env.LOWERING_MODEL_ALIAS;

const INPUT = { system: 'sys', task: 'task', traceId: 'trace-1' };

beforeEach(() => {
  process.env.LLM_GATEWAY_URL = 'http://gateway.test';
  delete process.env.LOWERING_MODEL_ALIAS;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGatewayUrl === undefined) delete process.env.LLM_GATEWAY_URL;
  else process.env.LLM_GATEWAY_URL = originalGatewayUrl;
  if (originalLoweringAlias === undefined) delete process.env.LOWERING_MODEL_ALIAS;
  else process.env.LOWERING_MODEL_ALIAS = originalLoweringAlias;
  vi.restoreAllMocks();
});

/** Mock fetch with a gateway-shaped body and hand back the spy. */
function mockGateway(body: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function sentBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = spy.mock.calls[0]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

describe('response parsing', () => {
  it('reads `content` from the TOP LEVEL of the gateway response', async () => {
    // The regression. This body is what the gateway actually returns
    // (llm_gateway_service/app/types.py ChatCompletionResponse).
    const spy = mockGateway({
      content: '[{"statement":"X","kind":"HYPOTHESIS"}]',
      finish_reason: 'stop',
      provider: 'anthropic',
      model: 'claude',
    });
    const out = await defaultGatewayLlm.complete(INPUT);
    expect(out).toBe('[{"statement":"X","kind":"HYPOTHESIS"}]');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('throws rather than returning "" when content is missing', async () => {
    // An OpenAI-shaped body is precisely what the old code was reading, and it
    // is the shape this gateway never sends. Under the old parse this resolved
    // to '' and the caller recorded NO_CLAIMS — a lie with a clean status.
    mockGateway({ choices: [{ message: { content: 'ignored' } }] });
    await expect(defaultGatewayLlm.complete(INPUT)).rejects.toThrow(/no usable `content`/);
  });

  it('throws on an empty-string content instead of passing it through', async () => {
    mockGateway({ content: '', finish_reason: 'stop' });
    await expect(defaultGatewayLlm.complete(INPUT)).rejects.toThrow(/no usable `content`/);
  });

  it('still throws on a non-2xx', async () => {
    mockGateway({ detail: 'boom' }, 503);
    await expect(defaultGatewayLlm.complete(INPUT)).rejects.toThrow(/LLM gateway returned 503/);
  });
});

describe('model selection', () => {
  it('sends NO model_alias when nothing is pinned, so task_tag can route it', async () => {
    // Previously this sent the literal string 'default', which is not a catalog
    // alias — a guaranteed 400 wearing the costume of a fallback.
    const spy = mockGateway({ content: '[]' });
    await defaultGatewayLlm.complete(INPUT);
    const body = sentBody(spy);
    expect(body.model_alias).toBeUndefined();
    expect(body.task_tag).toBe('claim_lowering');
  });

  it('honours LOWERING_MODEL_ALIAS when the operator pins one', async () => {
    process.env.LOWERING_MODEL_ALIAS = 'claude-haiku-4-5';
    const spy = mockGateway({ content: '[]' });
    await defaultGatewayLlm.complete(INPUT);
    expect(sentBody(spy).model_alias).toBe('claude-haiku-4-5');
  });

  it('lets an explicit per-call alias beat the env var', async () => {
    process.env.LOWERING_MODEL_ALIAS = 'from-env';
    const spy = mockGateway({ content: '[]' });
    await defaultGatewayLlm.complete({ ...INPUT, modelAlias: 'from-caller' });
    expect(sentBody(spy).model_alias).toBe('from-caller');
  });

  it('treats a whitespace-only alias as unpinned rather than sending it', async () => {
    process.env.LOWERING_MODEL_ALIAS = '   ';
    const spy = mockGateway({ content: '[]' });
    await defaultGatewayLlm.complete(INPUT);
    expect(sentBody(spy).model_alias).toBeUndefined();
  });
});
