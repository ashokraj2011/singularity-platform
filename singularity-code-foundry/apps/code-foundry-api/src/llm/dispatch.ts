/**
 * M42.4 — Compose-and-respond dispatch.
 *
 * Wraps a POST to prompt-composer's /api/v1/compose-and-respond
 * endpoint. The prompts themselves live in the composer DB under keys
 *   codegen.patch.system
 *   codegen.patch.system.brownfield
 *   codegen.patch.user-template
 * (seeded in a separate prompt-composer seed file when this milestone
 * lands; until then dispatch returns COMPOSER_UNCONFIGURED so callers
 * can still validate the Patch Guard with hand-crafted diffs).
 *
 * The bin/check-no-inline-prompts.sh CI guard forbids inline prompts
 * anywhere in the Foundry source — so this file MUST NOT carry the
 * actual prompt text.
 */
import axios from 'axios'
import { config } from '../config.js'
import { log } from '../lib/log.js'

export interface DispatchInput {
  /** Composer prompt-binding key (e.g. 'codegen.patch.user-template'). */
  promptKey: string
  /** Mustache vars rendered into the binding's template. */
  vars: Record<string, unknown>
  /** Optional model alias. Defaults to the gateway's default. */
  modelAlias?: string
}

export interface DispatchResult {
  status: 'OK' | 'COMPOSER_UNCONFIGURED' | 'ERROR'
  diff?: string
  cfCallId?: string
  bundleHash?: string
  rawResponse?: string
  error?: string
}

export async function dispatchPatchTask(input: DispatchInput): Promise<DispatchResult> {
  const url = `${config.PROMPT_COMPOSER_URL?.replace(/\/$/, '')}/api/v1/compose-and-respond`
  if (!config.PROMPT_COMPOSER_URL) {
    return { status: 'COMPOSER_UNCONFIGURED', error: 'PROMPT_COMPOSER_URL not set' }
  }
  try {
    const res = await axios.post(
      url,
      {
        prompt_key: input.promptKey,
        vars: input.vars,
        model_alias: input.modelAlias,
        // Foundry only accepts diff output.
        output_format: 'unified_diff',
      },
      {
        timeout: 60_000,
        headers: { 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )
    if (res.status >= 400) {
      log.warn({ status: res.status, body: typeof res.data === 'string' ? res.data.slice(0, 300) : res.data }, 'composer returned error')
      return {
        status: 'ERROR',
        error: `composer ${res.status}: ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data).slice(0, 300)}`,
      }
    }
    const body = res.data as {
      content?: string
      cf_call_id?: string
      bundle_hash?: string
    }
    return {
      status: 'OK',
      diff: extractUnifiedDiff(body.content ?? ''),
      cfCallId: body.cf_call_id,
      bundleHash: body.bundle_hash,
      rawResponse: typeof body === 'string' ? body : JSON.stringify(body).slice(0, 2000),
    }
  } catch (err) {
    return { status: 'ERROR', error: (err as Error).message }
  }
}

/**
 * Pull the unified diff out of an LLM response. The system prompt asks
 * the model to return JUST the diff, but in practice they often wrap it
 * in a code fence or add prose. Be forgiving — strip leading prose up
 * to the first '--- ' header and trailing fence/text after the last
 * hunk line.
 */
export function extractUnifiedDiff(text: string): string {
  if (!text) return ''
  // Strip ```diff or ```patch fences if present.
  const fence = /```(?:diff|patch)?\s*\n([\s\S]+?)\n```/i.exec(text)
  const candidate = fence ? fence[1] : text
  // Find first '--- ' line and trim everything before it.
  const idx = candidate.indexOf('\n--- ')
  if (idx > 0) return candidate.slice(idx + 1)
  if (candidate.startsWith('--- ')) return candidate
  return candidate.trim()
}
