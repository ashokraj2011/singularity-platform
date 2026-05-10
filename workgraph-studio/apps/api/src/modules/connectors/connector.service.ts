import type { ConnectorType } from '@prisma/client'
import type { ConnectorAdapter } from './connector-adapter'
import { HttpAdapter } from './adapters/http.adapter'
import { EmailAdapter } from './adapters/email.adapter'
import { TeamsAdapter } from './adapters/teams.adapter'
import { SlackAdapter } from './adapters/slack.adapter'
import { JiraAdapter } from './adapters/jira.adapter'
import { GitAdapter } from './adapters/git.adapter'
import { ConfluenceAdapter } from './adapters/confluence.adapter'
import { DatadogAdapter } from './adapters/datadog.adapter'
import { ServiceNowAdapter } from './adapters/servicenow.adapter'
import { LlmGatewayAdapter } from './adapters/llm-gateway.adapter'
import { S3Adapter } from './adapters/s3.adapter'
import { PostgresAdapter } from './adapters/postgres.adapter'

export function buildAdapter(type: ConnectorType, config: Record<string, unknown>, credentials: Record<string, unknown>): ConnectorAdapter {
  switch (type) {
    case 'HTTP':         return new HttpAdapter(config as any, credentials as any)
    case 'EMAIL':        return new EmailAdapter(config as any, credentials as any)
    case 'TEAMS':        return new TeamsAdapter(config as any, credentials as any)
    case 'SLACK':        return new SlackAdapter(config as any, credentials as any)
    case 'JIRA':         return new JiraAdapter(config as any, credentials as any)
    case 'GIT':          return new GitAdapter(config as any, credentials as any)
    case 'CONFLUENCE':   return new ConfluenceAdapter(config as any, credentials as any)
    case 'DATADOG':      return new DatadogAdapter(config as any, credentials as any)
    case 'SERVICENOW':   return new ServiceNowAdapter(config as any, credentials as any)
    case 'LLM_GATEWAY':  return new LlmGatewayAdapter(config as any, credentials as any)
    case 'S3':           return new S3Adapter(config as any, credentials as any)
    case 'POSTGRES':     return new PostgresAdapter(config as any, credentials as any)
    default: throw new Error(`Unsupported connector type: ${type}`)
  }
}
