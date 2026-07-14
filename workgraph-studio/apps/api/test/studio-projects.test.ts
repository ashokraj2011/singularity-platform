import { describe, it, expect } from 'vitest'
import { createProjectSchema, updateProjectSchema, archiveProjectSchema } from '../src/modules/studio/studio-projects.router'
import { shapeProject } from '../src/modules/studio/studio-projects.service'

describe('studio project schemas', () => {
  it('createProjectSchema requires a non-empty name, mission optional', () => {
    expect(createProjectSchema.safeParse({ name: 'Payments Reliability' }).success).toBe(true)
    expect(createProjectSchema.safeParse({ name: '  ' }).success).toBe(false)
    expect(createProjectSchema.safeParse({ mission: 'no name' }).success).toBe(false)
  })

  it('updateProjectSchema allows a partial patch and a null mission (clear it)', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(true)
    expect(updateProjectSchema.safeParse({ mission: null }).success).toBe(true)
    expect(updateProjectSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
  })

  it('archiveProjectSchema defaults archived to true', () => {
    expect(archiveProjectSchema.parse({})).toEqual({ archived: true })
    expect(archiveProjectSchema.parse({ archived: false })).toEqual({ archived: false })
  })
})

describe('shapeProject', () => {
  it('flattens _count.workItems into workItemCount', () => {
    const shaped = shapeProject({ id: 'p1', code: 'PRJ-ABCDE', name: 'X', _count: { workItems: 4 } })
    expect(shaped).toEqual({ id: 'p1', code: 'PRJ-ABCDE', name: 'X', workItemCount: 4 })
    expect('_count' in shaped).toBe(false)
  })
})
