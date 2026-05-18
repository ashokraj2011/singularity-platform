import axios from 'axios'
import { readFileSync } from 'node:fs'

export async function freezeCommand(opts: { spec: string; api: string; actor?: string }): Promise<void> {
  const yamlText = readFileSync(opts.spec, 'utf8')
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/spec/freeze`
  try {
    const res = await axios.post(url, yamlText, {
      headers: {
        'content-type': 'application/yaml',
        ...(opts.actor ? { 'x-actor-id': opts.actor } : {}),
      },
      timeout: 30_000,
      validateStatus: () => true,
    })
    if (res.status === 503 && res.data?.code === 'FEATURE_DISABLED') {
      process.stderr.write(`✗ Feature disabled: ${res.data.flag} (${res.data.disabledAncestor})\n`)
      process.stderr.write(`  ${res.data.message}\n`)
      throw Object.assign(new Error('feature disabled'), { exitCode: 4 })
    }
    if (res.status >= 400) {
      process.stderr.write(`✗ ${res.status} ${url}\n`)
      process.stderr.write(`  ${JSON.stringify(res.data, null, 2)}\n`)
      throw Object.assign(new Error('freeze failed'), { exitCode: 2 })
    }
    const body = res.data as {
      specId: string
      specName: string
      version: string
      specHash: string
      irHash: string
      runId: string
      receiptHash: string
    }
    process.stdout.write(`✓ ${opts.spec} frozen as ${body.specName}@${body.version}\n`)
    process.stdout.write(`    specId:      ${body.specId}\n`)
    process.stdout.write(`    specHash:    ${body.specHash}\n`)
    process.stdout.write(`    irHash:      ${body.irHash}\n`)
    process.stdout.write(`    runId:       ${body.runId}\n`)
    process.stdout.write(`    receiptHash: ${body.receiptHash}\n`)
  } catch (err) {
    if ((err as { exitCode?: number }).exitCode !== undefined) throw err
    process.stderr.write(`✗ freeze request failed: ${(err as Error).message}\n`)
    throw Object.assign(new Error('freeze failed'), { exitCode: 2 })
  }
}
