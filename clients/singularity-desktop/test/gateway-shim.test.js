'use strict'
// Plain-node tests for the local LLM shim translation (no test framework).
//   node test/gateway-shim.test.js   →  exits non-zero on failure.
const assert = require('node:assert')
const { sgToOpenAI, openAIToSg } = require('../src/gateway-shim')

// request: singularity-gateway → OpenAI
const oi = sgToOpenAI({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'apply_patch', description: 'patch', input_schema: { type: 'object' } }],
  model_alias: 'claude-sonnet', max_output_tokens: 256, temperature: 0.2,
  thinking_budget: 1000, prompt_cache: { enabled: true },
}, { model: 'gpt-4o' })
assert.equal(oi.model, 'gpt-4o')
assert.equal(oi.max_tokens, 256)
assert.equal(oi.temperature, 0.2)
assert.equal(oi.tools[0].type, 'function')
assert.equal(oi.tools[0].function.name, 'apply_patch')
assert.deepEqual(oi.tools[0].function.parameters, { type: 'object' })
assert.equal(oi.tool_choice, 'auto')
assert.ok(!('thinking_budget' in oi) && !('prompt_cache' in oi), 'drops sg-only fields')

// response: OpenAI → singularity-gateway
const sg = openAIToSg({
  choices: [{
    message: { content: 'done', tool_calls: [{ id: 't1', function: { name: 'apply_patch', arguments: '{"path":"x"}' } }] },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'gpt-4o',
}, { modelAlias: 'claude-sonnet', latencyMs: 42 })
assert.equal(sg.content, 'done')
assert.equal(sg.tool_calls[0].name, 'apply_patch')
assert.equal(sg.tool_calls[0].args.path, 'x')        // JSON-string arguments parsed
assert.equal(sg.input_tokens, 10)
assert.equal(sg.output_tokens, 5)
assert.equal(sg.finish_reason, 'tool_calls')
assert.equal(sg.provider, 'copilot-laptop')
assert.equal(sg.model_alias, 'claude-sonnet')

// empty / missing fields are tolerated
const empty = openAIToSg({}, {})
assert.equal(empty.content, '')
assert.deepEqual(empty.tool_calls, [])
assert.equal(empty.finish_reason, 'stop')

console.log('gateway-shim.test.js ✓ — all assertions passed')
