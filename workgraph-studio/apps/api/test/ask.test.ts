import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Synthesis 5.1 — Ask-Synthesis sidecar. Mocks the composed services (workspace / thread /
 * agent driver / messages) and asserts the pure orchestration: resolve-or-create the
 * per-project sidecar workspace + the single ASK_SIDECAR thread, delegate to the Facilitator,
 * and keep history read-only. No database, no LLM.
 */
const listWorkspacesMock = vi.fn()
const createWorkspaceMock = vi.fn()
const listThreadsMock = vi.fn()
const createThreadMock = vi.fn()
const runAgentTurnMock = vi.fn()
const listMessagesMock = vi.fn()

vi.mock('../src/modules/synthesis/workspace.service', () => ({
  listWorkspaces: (...a: unknown[]) => listWorkspacesMock(...a),
  createWorkspace: (...a: unknown[]) => createWorkspaceMock(...a),
  listThreads: (...a: unknown[]) => listThreadsMock(...a),
  createThread: (...a: unknown[]) => createThreadMock(...a),
}))
vi.mock('../src/modules/synthesis/synthesis-agent.service', () => ({ runAgentTurn: (...a: unknown[]) => runAgentTurnMock(...a) }))
vi.mock('../src/modules/synthesis/message.service', () => ({ listMessages: (...a: unknown[]) => listMessagesMock(...a) }))

import { ask, askHistory, ASK_SIDECAR_PURPOSE } from '../src/modules/synthesis/ask.service'

const req = {} as never

beforeEach(() => {
  ;[listWorkspacesMock, createWorkspaceMock, listThreadsMock, createThreadMock, listMessagesMock].forEach((m) => m.mockReset())
  runAgentTurnMock.mockReset().mockResolvedValue({ message: { id: 'm1' }, disposition: { kind: 'ANSWER' }, proposalId: null, manifestId: 'mf1' })
})

describe('ask — resolve sidecar + delegate to Facilitator', () => {
  it('with an explicit workspaceId, reuses the existing ASK_SIDECAR thread (no workspace/thread creates)', async () => {
    listThreadsMock.mockResolvedValue({ items: [{ id: 't-ask', kind: 'ASK_SIDECAR', createdAt: new Date('2020-01-01') }] })
    const r = await ask({ workspaceId: 'ws1' }, 'why?', req, 'user-1')
    expect(listWorkspacesMock).not.toHaveBeenCalled()
    expect(createThreadMock).not.toHaveBeenCalled()
    expect(runAgentTurnMock).toHaveBeenCalledWith('ws1', 't-ask', 'FACILITATOR', 'why?', req, 'user-1')
    expect(r).toMatchObject({ workspaceId: 'ws1', threadId: 't-ask', proposalId: null })
  })

  it('with a projectId and no sidecar yet, creates the Ask workspace + ASK_SIDECAR thread', async () => {
    listWorkspacesMock.mockResolvedValue({ items: [] })
    createWorkspaceMock.mockResolvedValue({ id: 'ws-new' })
    listThreadsMock.mockResolvedValue({ items: [] })
    createThreadMock.mockResolvedValue({ id: 't-new' })
    const r = await ask({ specificationProjectId: 'proj-1', workItemId: 'wi-9' }, 'draft a PRD', req, 'user-1')
    expect(createWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ specificationProjectId: 'proj-1', workItemId: 'wi-9', purpose: ASK_SIDECAR_PURPOSE, title: 'Ask Synthesis' }),
      'user-1',
    )
    expect(createThreadMock).toHaveBeenCalledWith('ws-new', expect.objectContaining({ kind: 'ASK_SIDECAR', agentRole: 'FACILITATOR' }), 'user-1')
    expect(runAgentTurnMock).toHaveBeenCalledWith('ws-new', 't-new', 'FACILITATOR', 'draft a PRD', req, 'user-1')
    expect(r.workspaceId).toBe('ws-new')
  })

  it('reuses the existing per-project sidecar workspace, picking the earliest-created', async () => {
    listWorkspacesMock.mockResolvedValue({ items: [
      { id: 'ws-late', purpose: ASK_SIDECAR_PURPOSE, createdAt: new Date('2022-05-01') },
      { id: 'ws-early', purpose: ASK_SIDECAR_PURPOSE, createdAt: new Date('2021-01-01') },
      { id: 'ws-session', purpose: 'a real session', createdAt: new Date('2020-01-01') },
    ] })
    listThreadsMock.mockResolvedValue({ items: [{ id: 't-ask', kind: 'ASK_SIDECAR', createdAt: new Date('2021-01-02') }] })
    await ask({ specificationProjectId: 'proj-1' }, 'q', req, 'user-1')
    expect(createWorkspaceMock).not.toHaveBeenCalled()
    expect(runAgentTurnMock).toHaveBeenCalledWith('ws-early', 't-ask', 'FACILITATOR', 'q', req, 'user-1')
  })

  it('rejects when neither workspaceId nor specificationProjectId is given', async () => {
    await expect(ask({}, 'q', req, 'user-1')).rejects.toThrow(/workspaceId or a specificationProjectId/)
  })
})

describe('askHistory — read-only, never creates', () => {
  it('returns an empty transcript when the project has no sidecar yet', async () => {
    listWorkspacesMock.mockResolvedValue({ items: [] })
    const r = await askHistory({ specificationProjectId: 'proj-1' })
    expect(r).toEqual({ workspaceId: null, threadId: null, items: [] })
    expect(createWorkspaceMock).not.toHaveBeenCalled()
    expect(createThreadMock).not.toHaveBeenCalled()
  })

  it('returns the sidecar thread messages when it exists', async () => {
    listThreadsMock.mockResolvedValue({ items: [{ id: 't-ask', kind: 'ASK_SIDECAR', createdAt: new Date('2021-01-02') }] })
    listMessagesMock.mockResolvedValue({ items: [{ id: 'm1', seq: 1 }] })
    const r = await askHistory({ workspaceId: 'ws1' })
    expect(createThreadMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ workspaceId: 'ws1', threadId: 't-ask' })
    expect(r.items).toHaveLength(1)
  })
})
