#!/usr/bin/env node
/**
 * M42.1 — singularity-codegen CLI.
 *
 * Spec spine commands only:
 *   spec init      Emit a starter spec.yaml.
 *   spec validate  Validate a spec file against the schema + policies.
 *                  Prints structured errors; exits non-zero on failure.
 *   spec freeze    POST the spec to the running code-foundry-api so
 *                  it gets persisted, IR-built, and receipt-stamped.
 *                  Requires the master + greenfield flags to be ON.
 *   spec history   Pretty-print the lifecycle event log for a specId.
 *
 * Generation / verification / patch commands arrive in M42.2-M42.4.
 */
import { Command } from 'commander'
import { initCommand } from './commands/init.js'
import { validateCommand } from './commands/validate.js'
import { freezeCommand } from './commands/freeze.js'
import { historyCommand } from './commands/history.js'

const program = new Command()
program
  .name('singularity-codegen')
  .description('Singularity Code Foundry — deterministic-first code generation (M42.1 spec spine)')
  .version('0.1.0')

const spec = program.command('spec').description('Spec authoring + lifecycle')

spec
  .command('init')
  .description('Emit a starter spec.yaml for the chosen stack')
  .option('-k, --kind <kind>', 'spec kind', 'service')
  .option('-s, --stack <stack>', 'spring | fastapi | express', 'spring')
  .option('-o, --out <path>', 'output file', 'spec.yaml')
  .action(initCommand)

spec
  .command('validate')
  .description('Validate a spec against schema + cross-field rules + default policies')
  .requiredOption('-s, --spec <path>', 'spec.yaml path')
  .action(validateCommand)

spec
  .command('freeze')
  .description('Submit a spec to code-foundry-api for IR build + receipt')
  .requiredOption('-s, --spec <path>', 'spec.yaml path')
  .option('--api <url>', 'code-foundry-api base url', process.env.CODE_FOUNDRY_API_URL ?? 'http://localhost:3005')
  .option('--actor <id>', 'actor user id stamped on the lifecycle event', process.env.USER ?? 'cli')
  .action(freezeCommand)

spec
  .command('history')
  .description('List lifecycle events for a spec')
  .requiredOption('-i, --id <specId>', 'codegen_specs.id')
  .option('--api <url>', 'code-foundry-api base url', process.env.CODE_FOUNDRY_API_URL ?? 'http://localhost:3005')
  .action(historyCommand)

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err)
  process.exit(typeof err.exitCode === 'number' ? err.exitCode : 1)
})
