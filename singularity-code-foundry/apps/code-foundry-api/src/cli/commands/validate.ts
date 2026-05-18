import { loadSpecFile } from '../../spec/load.js'
import { validateSpec } from '../../spec/validate.js'
import { runPolicies } from '../../policy/registry.js'
import { buildIr } from '../../ir/build.js'

export async function validateCommand(opts: { spec: string }): Promise<void> {
  const loaded = loadSpecFile(opts.spec)
  const result = validateSpec(loaded.raw)
  if (!result.valid) {
    process.stdout.write(`✗ ${opts.spec} — INVALID\n`)
    for (const e of result.errors) {
      process.stdout.write(`  ${e.code.padEnd(28)} ${e.path}\n`)
      process.stdout.write(`      ${e.message}\n`)
    }
    throw Object.assign(new Error('Spec validation failed'), { exitCode: 2 })
  }
  const policy = runPolicies(result.spec!)
  if (!policy.passed) {
    process.stdout.write(`✗ ${opts.spec} — POLICY VIOLATIONS\n`)
    for (const v of policy.errors) {
      process.stdout.write(`  ${v.policyId.padEnd(40)} ${v.path}\n`)
      process.stdout.write(`      ${v.message}\n`)
    }
    throw Object.assign(new Error('Policy validation failed'), { exitCode: 3 })
  }
  const ir = buildIr({ spec: result.spec!, specHash: result.specHash! })
  process.stdout.write(`✓ ${opts.spec} — OK\n`)
  process.stdout.write(`    specHash: ${result.specHash}\n`)
  process.stdout.write(`    irHash:   ${ir.meta.irHash}\n`)
  process.stdout.write(`    endpoints: ${ir.endpoints.length}, models: ${ir.models.length}, dataSources: ${ir.dataSources.length}\n`)
  process.stdout.write(`    coverage:\n`)
  for (const e of ir.endpoints) {
    process.stdout.write(`      • ${e.operationId.padEnd(36)} ${e.businessLogicCoverage}\n`)
  }
  for (const w of result.warnings) {
    process.stdout.write(`    ⚠ ${w.code.padEnd(36)} ${w.path}: ${w.message}\n`)
  }
  for (const w of policy.warnings) {
    process.stdout.write(`    ⚠ ${w.policyId.padEnd(36)} ${w.path}: ${w.message}\n`)
  }
}
