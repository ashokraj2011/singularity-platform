import axios from 'axios'

export async function detectGapsCommand(opts: { runId: string; api: string }): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/runs/${encodeURIComponent(opts.runId)}/detect-gaps`
  const res = await axios.post(url, undefined, { timeout: 60_000, validateStatus: () => true })
  if (res.status === 503 && res.data?.code === 'FEATURE_DISABLED') {
    process.stderr.write(`✗ Feature disabled: ${res.data.flag}\n`)
    throw Object.assign(new Error('feature disabled'), { exitCode: 4 })
  }
  if (res.status >= 400) {
    process.stderr.write(`✗ ${res.status} ${url}\n${JSON.stringify(res.data, null, 2)}\n`)
    throw Object.assign(new Error('detect-gaps failed'), { exitCode: 2 })
  }
  const body = res.data as {
    runId: string
    gapCount: number
    gaps: Array<{
      type: string
      severity: string
      filePath?: string
      regionId?: string
      description: string
      recommendedResolution?: string
      llmEligible: boolean
    }>
  }
  process.stdout.write(`${body.gapCount === 0 ? '✓' : 'ⓘ'} ${body.gapCount} gap${body.gapCount === 1 ? '' : 's'} detected in run ${body.runId.slice(0, 8)}…\n`)
  for (const g of body.gaps) {
    const llm = g.llmEligible ? '  (LLM-eligible)' : ''
    process.stdout.write(`  ${g.severity.padEnd(8)} ${g.type.padEnd(28)} ${g.filePath ?? ''}${g.regionId ? `#${g.regionId}` : ''}${llm}\n`)
    process.stdout.write(`        ${g.description}\n`)
    if (g.recommendedResolution) {
      process.stdout.write(`        → ${g.recommendedResolution}\n`)
    }
  }
}
