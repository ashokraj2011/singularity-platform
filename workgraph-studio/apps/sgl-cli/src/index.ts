#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { detectCopilotCli, SingularityLaptopSdk } from '@singularity/laptop-sdk'

const CONFIG_PATH = join(homedir(), '.singularity', 'sgl.json')

type Config = {
  apiBaseUrl?: string
  token?: string
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Config
  } catch {
    return {}
  }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

function option(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  const prefixed = args.find(arg => arg.startsWith(`${name}=`))
  return prefixed?.slice(name.length + 1)
}

async function sdkFromConfig(args: string[]): Promise<SingularityLaptopSdk> {
  const cfg = await loadConfig()
  const apiBaseUrl = option(args, '--api') ?? cfg.apiBaseUrl ?? process.env.SINGULARITY_API_URL ?? 'http://localhost:8080'
  const token = option(args, '--token') ?? cfg.token ?? process.env.SINGULARITY_TOKEN
  if (!token) throw new Error('Missing token. Run: sgl auth --token <jwt>')
  return new SingularityLaptopSdk({ apiBaseUrl, tokenProvider: () => token })
}

async function main() {
  const [, , command = 'help', ...args] = process.argv
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`sgl commands:
  auth --api <url> --token <jwt>
  work start <workItemId> [--agent-template <id>] [--capability <id>] [--mode direct-copilot|server-runtime]
  attach <invocationId>
  status <workItemId>
  questions answer <questionId> --answer <text>
  doctor
  version`)
    return
  }

  if (command === 'version') {
    console.log('sgl 0.1.0')
    return
  }

  if (command === 'auth') {
    const current = await loadConfig()
    const apiBaseUrl = option(args, '--api') ?? current.apiBaseUrl ?? 'http://localhost:8080'
    const token = option(args, '--token')
    if (!token) throw new Error('--token is required')
    await saveConfig({ ...current, apiBaseUrl, token })
    console.log(`Saved auth config for ${apiBaseUrl}`)
    return
  }

  if (command === 'doctor') {
    const cfg = await loadConfig()
    console.log(`API: ${cfg.apiBaseUrl ?? process.env.SINGULARITY_API_URL ?? 'http://localhost:8080'}`)
    console.log(`Token: ${cfg.token || process.env.SINGULARITY_TOKEN ? 'configured' : 'missing'}`)
    const copilot = await detectCopilotCli()
    console.log(`Copilot CLI: ${copilot.available ? `available (${copilot.version ?? 'unknown'})` : 'missing'}`)
    if (copilot.warning) console.log(`Warning: ${copilot.warning}`)
    return
  }

  if (command === 'work' && args[0] === 'start') {
    const workItemId = args[1]
    if (!workItemId) throw new Error('work item id is required')
    const sdk = await sdkFromConfig(args)
    const result = await sdk.startInvocation(workItemId, {
      client: 'sgl-cli',
      mode: (option(args, '--mode') as 'direct-copilot' | 'server-runtime' | undefined) ?? 'direct-copilot',
      agentTemplateId: option(args, '--agent-template'),
      capabilityId: option(args, '--capability'),
      repoUrl: option(args, '--repo'),
      branch: option(args, '--branch'),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'status') {
    const workItemId = args[0]
    if (!workItemId) throw new Error('work item id is required')
    const sdk = await sdkFromConfig(args)
    const result = await (sdk as unknown as { request<T>(method: string, path: string): Promise<T> })
      .request('GET', `/api/work-items/${encodeURIComponent(workItemId)}/laptop-invocations`)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'questions' && args[0] === 'answer') {
    const questionId = args[1]
    const answer = option(args, '--answer')
    if (!questionId || !answer) throw new Error('question id and --answer are required')
    const sdk = await sdkFromConfig(args)
    console.log(JSON.stringify(await sdk.answer(questionId, answer), null, 2))
    return
  }

  if (command === 'attach') {
    const invocationId = args[0]
    if (!invocationId) throw new Error('invocation id is required')
    const sdk = await sdkFromConfig(args)
    const stopHeartbeat = sdk.startHeartbeat(invocationId)
    console.log(`Attached to ${invocationId}. Heartbeats are running; press Ctrl+C to stop.`)
    process.on('SIGINT', () => {
      stopHeartbeat()
      process.exit(0)
    })
    await new Promise(() => undefined)
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch(err => {
  console.error((err as Error).message)
  process.exit(1)
})
