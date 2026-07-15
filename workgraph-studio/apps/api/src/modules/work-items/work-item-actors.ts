/** Explicit identities used by platform-owned WorkItem automation paths. */
export type SystemRouteSource =
  | 'event-trigger'
  | 'webhook-trigger'
  | 'schedule-trigger'
  | 'dependency-release'
  | 'work-item-node'
  | 'demo-verifier'

export const SYSTEM_ROUTE_ACTORS = new Set<string>([
  'system:event-trigger',
  'system:webhook-trigger',
  'system:schedule-trigger',
  'system:dependency-release',
  'system:work-item-node',
  'system:demo-verifier',
])

export function systemRouteActor(source: SystemRouteSource): string {
  return `system:${source}`
}
