import axios from 'axios'
import { readFileSync } from 'node:fs'

export async function generateCommand(opts: {
  spec: string
  out?: string
  api: string
  actor?: string
}): Promise<void> {
  const yamlText = readFileSync(opts.spec, 'utf8')
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/generate`
  const headers: Record<string, string> = { 'content-type': 'application/yaml' }
  if (opts.out) headers['x-output-dir'] = opts.out
  if (opts.actor) headers['x-actor-id'] = opts.actor

  const res = await axios.post(url, yamlText, { headers, timeout: 60_000, validateStatus: () => true })

  if (res.status === 503 && res.data?.code === 'FEATURE_DISABLED') {
    process.stderr.write(`✗ Feature disabled: ${res.data.flag}\n  ${res.data.message}\n`)
    throw Object.assign(new Error('feature disabled'), { exitCode: 4 })
  }
  if (res.status >= 400) {
    process.stderr.write(`✗ ${res.status} ${url}\n${JSON.stringify(res.data, null, 2)}\n`)
    throw Object.assign(new Error('generate failed'), { exitCode: 2 })
  }
  const body = res.data as {
    specId: string
    runId: string
    receiptHash: string
    specHash: string
    irHash: string
    templateVersion: string
    outputPath: string
    generatedFileCount: number
    manifestPath: string
    coverage: Array<{ operationId: string; coverage: string; willEmitEditableRegion: boolean }>
  }
  process.stdout.write(`✓ Generated ${body.generatedFileCount} files for spec ${body.specId.slice(0, 8)}…\n`)
  process.stdout.write(`    template:    ${body.templateVersion}\n`)
  process.stdout.write(`    output:      ${body.outputPath}\n`)
  process.stdout.write(`    manifest:    ${body.outputPath}/${body.manifestPath}\n`)
  process.stdout.write(`    runId:       ${body.runId}\n`)
  process.stdout.write(`    receiptHash: ${body.receiptHash}\n`)
  process.stdout.write(`    coverage:\n`)
  for (const c of body.coverage) {
    const tag = c.willEmitEditableRegion ? '  ⓘ' : '  ✓'
    process.stdout.write(`${tag} ${c.operationId.padEnd(40)} ${c.coverage}${c.willEmitEditableRegion ? '  (llm-editable region emitted)' : ''}\n`)
  }
}
