import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { activateHumanTask } from './HumanTaskExecutor'

type JsonObject = Record<string, unknown>

export async function activateWorkbenchTask(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const currentConfig = asObject(node.config)
  const workbench = asObject(currentConfig.workbench)
  const context = asObject(instance.context)
  const runtimeInputs = deriveRuntimeInputs(context, workbench)
  const renderedWorkbench = renderValue(workbench, {
    instance: {
      vars: asObject(context._vars),
      globals: asObject(context._globals),
    },
    vars: asObject(context._vars),
    globals: asObject(context._globals),
    workflow: {
      instanceId: instance.id,
      templateId: instance.templateId,
    },
    story: runtimeInputs.story,
    acceptanceCriteria: runtimeInputs.acceptanceCriteria,
    repoUrl: runtimeInputs.repoUrl,
  }) as JsonObject

  const nextWorkbench = normalizeWorkbenchDefaults(renderedWorkbench, runtimeInputs)
  const nextConfig: JsonObject = {
    ...currentConfig,
    workbench: nextWorkbench,
  }

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: {
      config: nextConfig as Prisma.InputJsonValue,
    },
  })

  const eventId = await logEvent('WorkbenchTaskPrepared', 'WorkflowNode', node.id, undefined, {
    instanceId: instance.id,
    sourceType: nextWorkbench.sourceType,
    hasStory: Boolean(runtimeInputs.story),
    hasRepo: Boolean(runtimeInputs.repoUrl),
  })
  await publishOutbox('WorkflowNode', node.id, 'WorkbenchTaskPrepared', {
    instanceId: instance.id,
    nodeId: node.id,
    eventId,
  })

  await activateHumanTask({ ...node, config: nextConfig as Prisma.JsonValue }, instance)
}

function normalizeWorkbenchDefaults(workbench: JsonObject, inputs: RuntimeInputs): JsonObject {
  const next: JsonObject = { ...workbench }
  const story = inputs.story || stringValue(next.fallbackGoal) || stringValue(next.goal)
  const acceptanceCriteria = inputs.acceptanceCriteria
  const repoUrl = inputs.repoUrl || stringValue(next.sourceUri)

  if (story) {
    next.goal = acceptanceCriteria
      ? `${story}\n\nAcceptance criteria:\n${acceptanceCriteria}`
      : story
  }
  if (repoUrl) {
    next.sourceUri = repoUrl
    if (isGithubUrl(repoUrl) && next.sourceType !== 'localdir') {
      next.sourceType = 'github'
    }
  }
  if (next.sourceType !== 'github' && next.sourceType !== 'localdir') {
    next.sourceType = isGithubUrl(repoUrl) ? 'github' : 'localdir'
  }
  next.workflowInputs = {
    story: inputs.story,
    acceptanceCriteria: inputs.acceptanceCriteria,
    repoUrl: inputs.repoUrl,
  }
  return next
}

type RuntimeInputs = {
  story: string
  acceptanceCriteria: string
  repoUrl: string
}

function deriveRuntimeInputs(context: JsonObject, workbench: JsonObject): RuntimeInputs {
  const vars = asObject(context._vars)
  const globals = asObject(context._globals)
  return {
    story: firstString(vars.story, vars.inputStory, vars.userStory, vars.requirement, globals.story, workbench.goal),
    acceptanceCriteria: firstString(
      vars.acceptanceCriteria,
      vars.acceptance_criteria,
      vars.definitionOfDone,
      globals.acceptanceCriteria,
    ),
    repoUrl: firstString(
      vars.repoUrl,
      vars.githubUrl,
      vars.repositoryUrl,
      vars.sourceUri,
      globals.repoUrl,
      workbench.sourceUri,
    ),
  }
}

function renderValue(value: unknown, context: JsonObject): unknown {
  if (typeof value === 'string') return renderTemplate(value, context)
  if (Array.isArray(value)) return value.map(item => renderValue(item, context))
  if (value && typeof value === 'object') {
    const out: JsonObject = {}
    for (const [key, child] of Object.entries(value as JsonObject)) {
      out[key] = renderValue(child, context)
    }
    return out
  }
  return value
}

function renderTemplate(template: string, context: JsonObject): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const value = lookupPath(context, rawPath.trim())
    return value === undefined || value === null ? '' : String(value)
  })
}

function lookupPath(root: JsonObject, path: string): unknown {
  const direct = root[path]
  if (direct !== undefined) return direct
  return path.split('.').reduce<unknown>((cursor, segment) => {
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      return (cursor as JsonObject)[segment]
    }
    return undefined
  }, root)
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value)
    if (text) return text
  }
  return ''
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isGithubUrl(value: string): boolean {
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+/i.test(value.trim())
}
