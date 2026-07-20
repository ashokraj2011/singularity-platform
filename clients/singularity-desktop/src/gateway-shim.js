'use strict'
// Local LLM gateway shim — makes "LLM on my laptop via Copilot" one-click.
//
// The laptop's mcp-server (model-run handler) POSTs a SINGULARITY-gateway-shaped
// chat request to LLM_GATEWAY_URL/v1/chat/completions. The raw Copilot bridge
// (copilot-api on :4141) speaks plain OpenAI, not the singularity shape
// (model_alias, prompt_cache, {name,input_schema} tools, snake_case usage). This
// shim sits between them: translate request → OpenAI → Copilot → translate
// response back to the singularity-gateway shape that ChatResponse.from_dict
// expects. Point the laptop's LLM_GATEWAY_URL at this shim.
//
// Pure functions (sgToOpenAI / openAIToSg) are exported for unit testing; the
// http server just wires them to the Copilot bridge.
const http = require('node:http')

// ── request: singularity-gateway → OpenAI (Copilot) ───────────────────────────
function sgToOpenAI(body, { model }) {
  const b = body || {}
  const out = {
    model,
    messages: Array.isArray(b.messages) ? b.messages : [],
  }
  if (Array.isArray(b.tools) && b.tools.length) {
    // singularity tool shape {name, description, input_schema} → OpenAI function
    out.tools = b.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? t.parameters ?? { type: 'object', properties: {} },
      },
    }))
    out.tool_choice = 'auto'
  }
  if (typeof b.temperature === 'number') out.temperature = b.temperature
  if (typeof b.max_output_tokens === 'number') out.max_tokens = b.max_output_tokens
  // thinking_budget + prompt_cache are singularity-only — dropped for Copilot.
  return out
}

// ── response: OpenAI (Copilot) → singularity-gateway ──────────────────────────
function openAIToSg(resp, { modelAlias, latencyMs }) {
  const r = resp || {}
  const choice = (Array.isArray(r.choices) ? r.choices[0] : null) || {}
  const msg = choice.message || {}
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  const usage = r.usage || {}
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    tool_calls: toolCalls.map((tc) => {
      const fn = tc.function || {}
      let args = fn.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = { _raw: args } }
      }
      return { id: tc.id || '', name: fn.name || tc.name || '', args: args || {} }
    }),
    finish_reason: choice.finish_reason || 'stop',
    input_tokens: Number(usage.prompt_tokens || 0),
    output_tokens: Number(usage.completion_tokens || 0),
    latency_ms: Math.max(0, Math.round(latencyMs || 0)),
    provider: 'copilot-laptop',
    model: r.model || '',
    model_alias: modelAlias || null,
    estimated_cost: 0,
  }
}

function _readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 16 * 1024 * 1024) req.destroy() })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

// ── http server ───────────────────────────────────────────────────────────────
// Resolve a platform alias to a concrete model understood by the local bridge.
// Explicit mappings win; otherwise a non-empty alias is treated as the concrete
// upstream model id. Unknown aliases therefore fail at the bridge instead of
// silently running the configured default model.
function resolveModelAlias(modelAlias, { defaultModel, modelMap = {} }) {
  const alias = typeof modelAlias === 'string' ? modelAlias.trim() : ''
  if (!alias) return { model: defaultModel, alias: null }
  const mapped = modelMap[alias]
  if (typeof mapped === 'string' && mapped.trim()) return { model: mapped.trim(), alias }
  return { model: alias, alias }
}

// opts: { copilotBase, defaultModel, modelMap?, bearer?, log? }
function createShimServer(opts) {
  const copilotBase = (opts.copilotBase || 'http://localhost:4141').replace(/\/$/, '')
  const defaultModel = opts.defaultModel || 'gpt-4o'
  const modelMap = opts.modelMap || {}
  const log = opts.log || (() => {})

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, target: copilotBase }))
      return
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404); res.end(); return
    }
    const startedAt = Date.now()
    try {
      const sgBody = await _readJson(req)
      const modelAlias = sgBody.model_alias || null
      const resolved = resolveModelAlias(modelAlias, { defaultModel, modelMap })
      const model = resolved.model
      const openaiReq = sgToOpenAI(sgBody, { model })

      const headers = { 'content-type': 'application/json' }
      if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
      const upstream = await fetch(`${copilotBase}/v1/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(openaiReq),
      })
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '')
        log(`[shim] copilot ${upstream.status}: ${text.slice(0, 200)}`)
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `copilot ${upstream.status}`, detail: text.slice(0, 500) }))
        return
      }
      const openaiResp = await upstream.json()
      const sgResp = openAIToSg(openaiResp, { modelAlias, latencyMs: Date.now() - startedAt })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(sgResp))
    } catch (err) {
      log(`[shim] error: ${err && err.message}`)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'shim_failed', detail: String(err && err.message) }))
    }
  })
}

module.exports = { sgToOpenAI, openAIToSg, resolveModelAlias, createShimServer }
