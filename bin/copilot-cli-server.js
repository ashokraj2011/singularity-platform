#!/usr/bin/env node
'use strict'
// copilot-cli-server — an OpenAI-compatible /v1/chat/completions endpoint backed
// by the OFFICIAL GitHub Copilot CLI (`copilot -p`). Lets the Singularity LLM
// gateway use Copilot with NO `copilot-api` package and NO third-party proxy —
// just the CLI you install from GitHub.
//
//   Install the CLI (no npm/artifactory needed):
//     curl -fsSL https://gh.io/copilot-install | bash      # or: npm i -g @github/copilot
//     copilot            # run once to sign in with your Copilot subscription
//
//   Run this server:
//     node bin/copilot-cli-server.js --port 4141
//     # optional: --model <m>  --copilot-bin <path>  --timeout-sec 300
//
//   Point Singularity at it (bin/setup.sh):
//     LLM provider = bridge · base URL = http://localhost:4141/v1 · model = gpt-4o · token = anything
//
// NOTE (path A, see platform-handbook §13.4): the Copilot CLI is an AGENT — in
// `-p --allow-all` it executes its own tools and returns TEXT, not OpenAI
// tool_calls. Great for chat/doc stages (Requirements, Design); governed code
// stages (Develop's apply_patch/run_command) won't receive function-calls. The
// "CLI as executor" model (§13.4) is the follow-up for governed tool stages.
const http = require('node:http')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const PORT = Number(arg('port', process.env.COPILOT_CLI_PORT || 4141))
const MODEL = arg('model', process.env.COPILOT_CLI_MODEL || '')      // '' → let the CLI use its default
const BIN = arg('copilot-bin', process.env.COPILOT_BIN || 'copilot')
const TIMEOUT = Number(arg('timeout-sec', process.env.COPILOT_CLI_TIMEOUT || 300)) * 1000

// ── messages[] → a single prompt the CLI `-p` flag accepts ────────────────────
function buildPrompt(messages) {
  if (!Array.isArray(messages)) return ''
  return messages.map((m) => {
    let content = m && m.content
    if (Array.isArray(content)) content = content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join('')
    return `${String((m && m.role) || 'user').toUpperCase()}: ${content == null ? '' : content}`
  }).join('\n\n')
}

// ── CLI stdout → OpenAI chat.completion (what the gateway's openai_compat reads) ─
function toOpenAIResponse(text, model, promptChars) {
  const content = String(text || '').trim()
  const est = (s) => Math.max(1, Math.round((s || 0) / 4))
  return {
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'copilot-cli',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: est(promptChars), completion_tokens: est(content.length), total_tokens: est((promptChars || 0) + content.length) },
  }
}

function runCopilot(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--allow-all']
    if (model) args.push('--model', model)
    const child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} reject(new Error(`copilot CLI timed out after ${TIMEOUT / 1000}s`)) }, TIMEOUT)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`failed to spawn '${BIN}': ${e.message}. Is the Copilot CLI installed and in PATH?`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`copilot CLI exited ${code}: ${(err || out).slice(0, 500)}`))
    })
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 16 * 1024 * 1024) req.destroy() })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, bin: BIN, model: MODEL || '(cli default)' })
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models'))
    return send(200, { object: 'list', data: [{ id: MODEL || 'copilot-cli', object: 'model', owned_by: 'github-copilot-cli' }] })
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    try {
      const body = await readBody(req)
      const prompt = buildPrompt(body.messages)
      if (!prompt) return send(400, { error: { message: 'no messages', type: 'invalid_request_error' } })
      const model = body.model || MODEL || undefined
      const startedAt = Date.now()
      const out = await runCopilot(prompt, model)
      console.log(`[copilot-cli] ${prompt.length}c → ${out.length}c in ${Date.now() - startedAt}ms`)
      return send(200, toOpenAIResponse(out, model, prompt.length))
    } catch (e) {
      console.error('[copilot-cli] error:', e.message)
      return send(502, { error: { message: e.message, type: 'copilot_cli_error' } })
    }
  }
  send(404, { error: { message: 'not found', type: 'invalid_request_error' } })
})

if (require.main === module) {
  server.listen(PORT, () => console.log(`copilot-cli-server → http://localhost:${PORT}/v1   (bin=${BIN}, model=${MODEL || 'cli default'}, timeout=${TIMEOUT / 1000}s)`))
}
module.exports = { buildPrompt, toOpenAIResponse }
