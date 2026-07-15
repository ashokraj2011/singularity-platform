import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { archiveAxesSchema, conceptCardBodySchema, createArchiveSchema, createProposalSchema, pathfinderSchema, type StageCardInput, stageCardSchema } from './archive.schemas'
import { cellKeyOf, compositeScoreOf, considerInsertion, coverageOf, dedupCheckWithEmbeddings, pathfinderRank } from './archive.engine'

const tenantId = () => currentTenantIdForDb() ?? undefined
const tenantWhere = () => (tenantId() ? { tenantId: tenantId() } : {})
type Db = typeof prisma | Prisma.TransactionClient

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

const DEFAULT_BUDGET = { maxCards: 500, maxProposals: 100, maxEmbeddingCalls: 1000, maxSearchExpansions: 200 }
const DEFAULT_USAGE = { cards: 0, proposals: 0, embeddingCalls: 0, searchExpansions: 0 }

function budgetOf(value: unknown) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    maxCards: Number.isFinite(Number(row.maxCards)) ? Number(row.maxCards) : DEFAULT_BUDGET.maxCards,
    maxProposals: Number.isFinite(Number(row.maxProposals)) ? Number(row.maxProposals) : DEFAULT_BUDGET.maxProposals,
    maxEmbeddingCalls: Number.isFinite(Number(row.maxEmbeddingCalls)) ? Number(row.maxEmbeddingCalls) : DEFAULT_BUDGET.maxEmbeddingCalls,
    maxSearchExpansions: Number.isFinite(Number(row.maxSearchExpansions)) ? Number(row.maxSearchExpansions) : DEFAULT_BUDGET.maxSearchExpansions,
  }
}

function usageOf(value: unknown) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    cards: Number(row.cards) || 0,
    proposals: Number(row.proposals) || 0,
    embeddingCalls: Number(row.embeddingCalls) || 0,
    searchExpansions: Number(row.searchExpansions) || 0,
  }
}

async function resolveEmbedding(text: string): Promise<{ vector?: number[]; model?: string }> {
  const url = process.env.CONCEPT_ARCHIVE_EMBEDDING_URL?.trim()
  if (!url) return {}
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.CONCEPT_ARCHIVE_EMBEDDING_TOKEN ? { authorization: `Bearer ${process.env.CONCEPT_ARCHIVE_EMBEDDING_TOKEN}` } : {}) },
      body: JSON.stringify({ input: [text] }),
      signal: controller.signal,
    })
    if (!response.ok) return {}
    const body = await response.json() as Record<string, unknown>
    const data = Array.isArray(body.data) ? body.data : Array.isArray(body.embeddings) ? body.embeddings : []
    const first = data[0]
    const vector = Array.isArray(first) ? first : first && typeof first === 'object' && Array.isArray((first as Record<string, unknown>).embedding) ? (first as Record<string, unknown>).embedding : undefined
    const candidateVector: unknown[] | undefined = Array.isArray(vector) ? vector : undefined
    return { vector: candidateVector?.every((value: unknown) => typeof value === 'number' && Number.isFinite(value)) ? candidateVector as number[] : undefined, model: typeof body.model === 'string' ? body.model : undefined }
  } catch {
    return {}
  } finally {
    clearTimeout(timeout)
  }
}

async function studioOrThrow(id: string, db: Db = prisma) {
  const studio = await db.studio.findFirst({
    where: { id, ...tenantWhere() },
    include: { project: { select: { id: true, name: true, code: true } }, _count: { select: { conceptArchives: true, proposals: true } } },
  })
  if (!studio) throw new NotFoundError('Studio', id)
  return studio
}

async function archiveOrThrow(id: string, db: Db = prisma) {
  const archive = await db.conceptArchive.findFirst({ where: { id, ...tenantWhere() } })
  if (!archive) throw new NotFoundError('ConceptArchive', id)
  return archive
}

async function appendArchiveEvent(
  db: Prisma.TransactionClient,
  input: { archiveId: string; cardId?: string; cellKey?: string; eventType: string; actorType: string; actorId?: string; payload?: Record<string, unknown> },
) {
  return db.archiveEvent.create({
    data: {
      archiveId: input.archiveId,
      cardId: input.cardId ?? null,
      cellKey: input.cellKey ?? null,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      payload: json(input.payload ?? {}),
    },
  })
}

function cardView(card: any) {
  const { embedding: _embedding, ...safeCard } = card
  return { ...safeCard, votes: card.votes?.map((vote: any) => ({ userId: vote.userId, direction: vote.direction })) ?? [] }
}

export async function listStudios(projectId?: string) {
  const studios = await prisma.studio.findMany({
    where: { ...tenantWhere(), ...(projectId ? { projectId } : {}) },
    include: { project: { select: { id: true, name: true, code: true } }, _count: { select: { conceptArchives: true, proposals: true } } },
    orderBy: { updatedAt: 'desc' },
  })
  return { items: studios }
}

export async function createOrGetStudio(projectId: string, input: { name?: string }, userId: string) {
  const project = await prisma.specificationProject.findFirst({ where: { id: projectId, ...tenantWhere() }, select: { id: true, name: true } })
  if (!project) throw new NotFoundError('SpecificationProject', projectId)
  const existing = await prisma.studio.findFirst({ where: { projectId, ...tenantWhere() } })
  if (existing) return studioOrThrow(existing.id)
  const studio = await prisma.studio.create({ data: { projectId, name: input.name?.trim() || `${project.name} Studio`, createdById: userId, tenantId: tenantId() } })
  await logEvent('StudioCreated', 'Studio', studio.id, userId, { projectId })
  await publishOutbox('Studio', studio.id, 'StudioCreated', { projectId, actorId: userId })
  return studioOrThrow(studio.id)
}

export async function listArchives(studioId: string) {
  await studioOrThrow(studioId)
  const archives = await prisma.conceptArchive.findMany({
    where: { studioId, ...tenantWhere() },
    include: { _count: { select: { cards: true, cells: true, events: true } } },
    orderBy: { updatedAt: 'desc' },
  })
  return { items: archives }
}

export async function createArchive(studioId: string, input: unknown, userId: string) {
  const parsed = createArchiveSchema.parse(input)
  await studioOrThrow(studioId)
  const archive = await prisma.conceptArchive.create({
    data: { studioId, name: parsed.name, axes: json(parsed.axes), fitnessConfig: json(parsed.fitnessConfig), budgetConfig: json(parsed.budgetConfig), createdById: userId, tenantId: tenantId() },
  })
  await withTenantDbTransaction(prisma, tx => appendArchiveEvent(tx, { archiveId: archive.id, eventType: 'ARCHIVE_CREATED', actorType: 'HUMAN', actorId: userId, payload: { axesRevision: 1 } }))
  await logEvent('ConceptArchiveCreated', 'ConceptArchive', archive.id, userId, { studioId })
  await publishOutbox('ConceptArchive', archive.id, 'ConceptArchiveCreated', { studioId, actorId: userId })
  return getArchive(archive.id)
}

export async function getArchive(archiveId: string) {
  const archive = await prisma.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() }, include: { studio: { select: { projectId: true, name: true } } } })
  if (!archive) throw new NotFoundError('ConceptArchive', archiveId)
  const [cards, cells, events] = await Promise.all([
    prisma.conceptCard.findMany({ where: { archiveId, ...tenantWhere() }, include: { votes: true }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] }),
    prisma.archiveCellState.findMany({ where: { archiveId }, orderBy: [{ axesRevision: 'desc' }, { cellKey: 'asc' }] }),
    prisma.archiveEvent.findMany({ where: { archiveId }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ])
  const axes = archiveAxesSchema.parse(archive.axes)
  const currentCells = cells.filter(cell => cell.axesRevision === archive.axesRevision)
  return {
    archive,
    cards: cards.map(cardView),
    cells,
    events,
    coverage: coverageOf(axes, currentCells),
    staged: cards.filter(card => card.status === 'STAGED').map(cardView),
    currentRevision: archive.axesRevision,
  }
}

async function stageCardInTx(tx: Prisma.TransactionClient, archive: any, parsed: StageCardInput, userId: string, embedding?: { vector?: number[]; model?: string }) {
  const axes = archiveAxesSchema.parse(archive.axes)
  cellKeyOf(axes, parsed.declaredCoords)
  const budget = budgetOf(archive.budgetConfig)
  const usage = usageOf(archive.budgetUsage)
  if (usage.cards >= budget.maxCards) throw new ConflictError(`Archive card budget exhausted (${budget.maxCards}). Increase the archive budget or freeze/recut before adding more.`)
  const compositeScore = compositeScoreOf(parsed.fitness, archive.fitnessConfig as Record<string, number>)
  const card = await tx.conceptCard.create({
    data: {
      archiveId: archive.id,
      title: parsed.title,
      summary: parsed.summary,
      body: json(conceptCardBodySchema.parse(parsed.body)),
      declaredCoords: json(parsed.declaredCoords),
      fitness: json(parsed.fitness),
      ...(embedding?.vector ? { embedding: json(embedding.vector), embeddingModel: embedding.model ?? 'configured-provider' } : {}),
      compositeScore,
      authorType: parsed.authorType,
      authorId: userId,
      agentRole: parsed.agentRole ?? null,
      traceId: parsed.traceId ?? null,
      parentCardIds: json(parsed.parentCardIds),
      operator: parsed.operator,
      operatorNote: parsed.operatorNote ?? null,
      tenantId: tenantId(),
    },
  })
  await tx.conceptArchive.update({ where: { id: archive.id }, data: { budgetUsage: json({ ...usage, cards: usage.cards + 1, embeddingCalls: usage.embeddingCalls + (embedding?.vector ? 1 : 0) }) } })
  await appendArchiveEvent(tx, { archiveId: archive.id, cardId: card.id, eventType: 'CARD_STAGED', actorType: parsed.authorType, actorId: userId, payload: { operator: parsed.operator, compositeScore } })
  return card
}

export async function stageCard(archiveId: string, input: unknown, userId: string) {
  const parsed = stageCardSchema.parse(input)
  const archiveSnapshot = await archiveOrThrow(archiveId)
  const existing = await prisma.conceptCard.findMany({ where: { archiveId, ...tenantWhere() }, select: { title: true, summary: true, embedding: true } })
  const text = `${parsed.title}\n${parsed.summary}`
  const embeddingBudget = budgetOf(archiveSnapshot.budgetConfig)
  const embeddingUsage = usageOf(archiveSnapshot.budgetUsage)
  const embedding = embeddingUsage.embeddingCalls < embeddingBudget.maxEmbeddingCalls ? await resolveEmbedding(text) : {}
  const duplicate = dedupCheckWithEmbeddings(text, embedding.vector, existing.map(card => ({ text: `${card.title}\n${card.summary}`, embedding: Array.isArray(card.embedding) ? card.embedding as number[] : null })))
  if (duplicate.duplicate && !parsed.allowDuplicate) throw new ConflictError(`This concept is too close to an existing card (similarity ${duplicate.similarity.toFixed(2)}). Use an explicit mutation or enable duplicate staging.`)
  const result = await withTenantDbTransaction(prisma, async tx => {
    const archive = await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() } })
    if (!archive) throw new NotFoundError('ConceptArchive', archiveId)
    if (archive.status !== 'ACTIVE') throw new ConflictError('A frozen archive cannot accept new cards.')
    return stageCardInTx(tx, archive, parsed, userId, embedding)
  })
  await logEvent('ConceptCardStaged', 'ConceptCard', result.id, userId, { archiveId, authorType: parsed.authorType })
  await publishOutbox('ConceptCard', result.id, 'ConceptCardStaged', { archiveId, actorId: userId })
  return cardView(result)
}

export async function confirmCardCoords(cardId: string, input: unknown, userId: string) {
  const parsed = (await import('./archive.schemas')).confirmCoordsSchema.parse(input)
  const result = await withTenantDbTransaction(prisma, async tx => {
    const card = await tx.conceptCard.findFirst({ where: { id: cardId, ...tenantWhere() }, include: { archive: true } })
    if (!card) throw new NotFoundError('ConceptCard', cardId)
    if (card.status !== 'STAGED') throw new ConflictError('Only staged cards can be placed into an archive cell.')
    if (card.archive.status !== 'ACTIVE') throw new ConflictError('A frozen archive cannot accept coordinate changes.')
    const axes = archiveAxesSchema.parse(card.archive.axes)
    const cellKey = cellKeyOf(axes, parsed.coords)
    const cell = await tx.archiveCellState.findUnique({ where: { archiveId_axesRevision_cellKey: { archiveId: card.archiveId, axesRevision: card.archive.axesRevision, cellKey } } })
    const currentElite = cell?.eliteCardId
      ? await tx.conceptCard.findUnique({ where: { id: cell.eliteCardId }, select: { id: true, authorType: true, pinned: true, compositeScore: true } }) as ({ id: string; authorType: 'HUMAN' | 'AGENT'; pinned: boolean; compositeScore: number } | null)
      : null
    const decision = considerInsertion({ killed: cell?.killed, elite: currentElite }, { id: card.id, authorType: card.authorType as 'HUMAN' | 'AGENT', compositeScore: card.compositeScore }, { humanOverride: parsed.replaceExisting })
    if (decision.kind === 'CELL_KILLED') throw new ConflictError('This archive cell is killed and cannot receive a card.')
    const updated = await tx.conceptCard.update({ where: { id: card.id }, data: { confirmedCoords: json(parsed.coords), coordsAxesRevision: card.archive.axesRevision, cellKey } })
    if (decision.kind === 'PLACE_ELITE') {
      if (!cell) {
        await tx.archiveCellState.create({ data: { archiveId: card.archiveId, cellKey, axesRevision: card.archive.axesRevision, eliteCardId: card.id, tenantId: tenantId() } })
      } else {
        const fenced = await tx.archiveCellState.updateMany({ where: { id: cell.id, eliteCardId: cell.eliteCardId }, data: { eliteCardId: card.id } })
        if (fenced.count !== 1) throw new ConflictError('The archive cell changed while you were placing this card. Reload and retry.')
      }
      if (currentElite?.id) await tx.conceptCard.update({ where: { id: currentElite.id }, data: { status: 'DISPLACED' } })
      await tx.conceptCard.update({ where: { id: card.id }, data: { status: 'ELITE' } })
    }
    if (decision.kind === 'PROPOSE_SWAP') {
      const budget = budgetOf(card.archive.budgetConfig)
      const usage = usageOf(card.archive.budgetUsage)
      if (usage.proposals >= budget.maxProposals) throw new ConflictError(`Archive proposal budget exhausted (${budget.maxProposals}).`)
      await tx.studioProposal.create({
        data: {
          studioId: card.archive.studioId,
          scopeType: 'ARCHIVE_CELL',
          scopeRef: json({ archiveId: card.archiveId, cellKey, currentEliteId: currentElite?.id ?? null, candidateCardId: card.id }),
          kind: 'SWAP',
          payload: json({ note: parsed.note ?? null, reason: decision.reason }),
          baseRevision: card.archive.axesRevision,
          authorType: 'HUMAN',
          authorId: userId,
          tenantId: tenantId(),
        },
      })
      await tx.conceptArchive.update({ where: { id: card.archiveId }, data: { budgetUsage: json({ ...usage, proposals: usage.proposals + 1 }) } })
    }
    await appendArchiveEvent(tx, { archiveId: card.archiveId, cardId: card.id, cellKey, eventType: 'CARD_COORDS_CONFIRMED', actorType: 'HUMAN', actorId: userId, payload: { decision: decision.kind, reason: decision.reason } })
    return { card: updated, decision }
  })
  await logEvent('ConceptCardCoordinatesConfirmed', 'ConceptCard', cardId, userId, { decision: result.decision.kind })
  return { card: cardView(result.card), decision: result.decision }
}

export async function voteCard(cardId: string, direction: -1 | 0 | 1, userId: string) {
  const result = await withTenantDbTransaction(prisma, async tx => {
    const card = await tx.conceptCard.findFirst({ where: { id: cardId, ...tenantWhere() }, include: { archive: true } })
    if (!card) throw new NotFoundError('ConceptCard', cardId)
    await tx.conceptCardVote.upsert({ where: { cardId_userId: { cardId, userId } }, create: { cardId, userId, direction, tenantId: tenantId() }, update: { direction } })
    const votes = await tx.conceptCardVote.findMany({ where: { cardId } })
    const voteScore = votes.reduce((sum, vote) => sum + vote.direction, 0)
    const fitness = { ...(card.fitness as Record<string, number>), votes: voteScore }
    const compositeScore = compositeScoreOf(fitness, { ...(card.archive.fitnessConfig as Record<string, number>), votes: 0.25 })
    const updated = await tx.conceptCard.update({ where: { id: cardId }, data: { fitness: json(fitness), compositeScore } })
    await appendArchiveEvent(tx, { archiveId: card.archiveId, cardId, eventType: 'CARD_VOTED', actorType: 'HUMAN', actorId: userId, payload: { direction, voteScore, compositeScore } })
    return updated
  })
  return cardView(result)
}

export async function pinCard(cardId: string, pinned: boolean, userId: string, note?: string) {
  const result = await withTenantDbTransaction(prisma, async tx => {
    const card = await tx.conceptCard.findFirst({ where: { id: cardId, ...tenantWhere() } })
    if (!card) throw new NotFoundError('ConceptCard', cardId)
    const updated = await tx.conceptCard.update({ where: { id: cardId }, data: { pinned, pinnedById: pinned ? userId : null } })
    await appendArchiveEvent(tx, { archiveId: card.archiveId, cardId, eventType: pinned ? 'CARD_PINNED' : 'CARD_UNPINNED', actorType: 'HUMAN', actorId: userId, payload: { note: note ?? null } })
    return updated
  })
  return cardView(result)
}

export async function killCell(archiveId: string, cellKey: string, reason: string, userId: string) {
  const result = await withTenantDbTransaction(prisma, async tx => {
    const archive = await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() }, include: { studio: true } })
    if (!archive) throw new NotFoundError('ConceptArchive', archiveId)
    if (archive.status !== 'ACTIVE') throw new ConflictError('A frozen archive cannot change cell state.')
    const cell = await tx.archiveCellState.findUnique({ where: { archiveId_axesRevision_cellKey: { archiveId, axesRevision: archive.axesRevision, cellKey } } })
    if (cell?.killed) throw new ConflictError('This cell is already killed.')
    let claimId: string | null = null
    const claim = await tx.claim.create({
      data: {
        projectId: archive.studio.projectId,
        statement: `Archive cell ${cellKey} is not viable: ${reason}`,
        riskiestAssumption: reason,
        claimType: 'TECHNICAL',
        contextScope: 'concept_archive',
        entityKind: 'ARCHIVE_CELL',
        entityId: `${archiveId}:${cellKey}`,
        stewardId: userId,
        createdById: userId,
        provenance: json({ origin: 'concept_archive', archiveId, cellKey }),
        tenantId: tenantId(),
      },
    })
    claimId = claim.id
    const next = cell
      ? await tx.archiveCellState.update({ where: { id: cell.id }, data: { killed: true, killReason: reason, killClaimId: claimId, killedById: userId, eliteCardId: null } })
      : await tx.archiveCellState.create({ data: { archiveId, cellKey, axesRevision: archive.axesRevision, killed: true, killReason: reason, killClaimId: claimId, killedById: userId, tenantId: tenantId() } })
    if (cell?.eliteCardId) await tx.conceptCard.update({ where: { id: cell.eliteCardId }, data: { status: 'KILLED_WITH_CELL' } })
    await appendArchiveEvent(tx, { archiveId, cellKey, eventType: 'CELL_KILLED', actorType: 'HUMAN', actorId: userId, payload: { reason, claimId } })
    return { cell: next, claimId }
  })
  await logEvent('ConceptArchiveCellKilled', 'ConceptArchive', archiveId, userId, { cellKey, claimId: result.claimId })
  await publishOutbox('ConceptArchive', archiveId, 'ConceptArchiveCellKilled', { cellKey, claimId: result.claimId, actorId: userId })
  return result
}

export async function promoteCard(cardId: string, promotedRef: Record<string, unknown>, userId: string, note?: string) {
  const card = await prisma.conceptCard.findFirst({ where: { id: cardId, ...tenantWhere() } })
  if (!card) throw new NotFoundError('ConceptCard', cardId)
  if (!['ELITE', 'PINNED'].includes(card.status) && !card.pinned) throw new ConflictError('Only an elite or pinned card can be promoted.')
  const updated = await prisma.conceptCard.update({ where: { id: cardId }, data: { status: 'PROMOTED', promotedRef: json(promotedRef), operatorNote: note ?? card.operatorNote } })
  await prisma.archiveEvent.create({ data: { archiveId: card.archiveId, cardId, eventType: 'CARD_PROMOTED', actorType: 'HUMAN', actorId: userId, payload: json({ promotedRef, note: note ?? null }) } })
  await logEvent('ConceptCardPromoted', 'ConceptCard', cardId, userId, { archiveId: card.archiveId })
  return cardView(updated)
}

export async function freezeArchive(archiveId: string, cardIds: string[], userId: string, note?: string) {
  const result = await withTenantDbTransaction(prisma, async tx => {
    const archive = await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() } })
    if (!archive) throw new NotFoundError('ConceptArchive', archiveId)
    if (archive.status !== 'ACTIVE') throw new ConflictError('Only an active archive can be frozen.')
    const cards = await tx.conceptCard.findMany({ where: { archiveId, id: { in: cardIds } } })
    if (cards.length !== new Set(cardIds).size || cards.some(card => !['ELITE', 'PROMOTED'].includes(card.status) && !card.pinned)) throw new ValidationError('Every frozen card must be a current elite or pinned card.')
    const cellKeys = cards.map(card => card.cellKey).filter(Boolean)
    if (new Set(cellKeys).size !== cellKeys.length) throw new ValidationError('A portfolio freeze cannot contain duplicate archive cells.')
    const contentHash = createHash('sha256').update(JSON.stringify({ archiveId, axes: archive.axes, axesRevision: archive.axesRevision, cards: cards.map(card => ({ id: card.id, cellKey: card.cellKey, body: card.body, score: card.compositeScore })) })).digest('hex')
    const frozen = await tx.conceptArchive.update({ where: { id: archiveId }, data: { status: 'FROZEN', frozenAt: new Date(), contentHash } })
    await appendArchiveEvent(tx, { archiveId, eventType: 'ARCHIVE_FROZEN', actorType: 'HUMAN', actorId: userId, payload: { cardIds, contentHash, note: note ?? null } })
    return frozen
  })
  await logEvent('ConceptArchiveFrozen', 'ConceptArchive', archiveId, userId, { contentHash: result.contentHash })
  await publishOutbox('ConceptArchive', archiveId, 'ConceptArchiveFrozen', { contentHash: result.contentHash, actorId: userId })
  return getArchive(archiveId)
}

export async function recutArchive(archiveId: string, input: unknown, userId: string) {
  const parsed = (await import('./archive.schemas')).recutAxesSchema.parse(input)
  const result = await withTenantDbTransaction(prisma, async tx => {
    const archive = await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() } })
    if (!archive) throw new NotFoundError('ConceptArchive', archiveId)
    if (archive.status !== 'ACTIVE') throw new ConflictError('A frozen archive cannot be recut.')
    const nextRevision = archive.axesRevision + 1
    await tx.conceptCard.updateMany({ where: { archiveId, status: { not: 'KILLED_WITH_CELL' } }, data: { status: 'STAGED', confirmedCoords: Prisma.JsonNull, coordsAxesRevision: null, cellKey: null } })
    const updated = await tx.conceptArchive.update({ where: { id: archiveId }, data: { axes: json(parsed.axes), axesRevision: nextRevision, contentHash: null } })
    await appendArchiveEvent(tx, { archiveId, eventType: 'ARCHIVE_RECUT', actorType: 'HUMAN', actorId: userId, payload: { axesRevision: nextRevision, note: parsed.note } })
    return updated
  })
  await logEvent('ConceptArchiveRecut', 'ConceptArchive', archiveId, userId, { axesRevision: result.axesRevision })
  return getArchive(archiveId)
}

export async function pathfinder(archiveId: string, input: unknown, userId: string) {
  const parsed = pathfinderSchema.parse(input)
  const archive = await archiveOrThrow(archiveId)
  const budget = budgetOf(archive.budgetConfig)
  const usage = usageOf(archive.budgetUsage)
  const remaining = Math.max(0, budget.maxSearchExpansions - usage.searchExpansions)
  const maxExpansions = Math.min(parsed.maxExpansions ?? budget.maxSearchExpansions, remaining)
  if (maxExpansions < 1) throw new ConflictError(`Pathfinder budget exhausted (${budget.maxSearchExpansions} expansions).`)
  const cards = await prisma.conceptCard.findMany({ where: { archiveId, ...tenantWhere(), status: { not: 'KILLED_WITH_CELL' } }, select: { id: true, title: true, summary: true, status: true, cellKey: true, compositeScore: true, parentCardIds: true } })
  const ranked = pathfinderRank(parsed.query, cards.map(card => ({ ...card, parentCardIds: Array.isArray(card.parentCardIds) ? card.parentCardIds as string[] : [] })), { maxResults: parsed.maxResults, maxExpansions })
  await withTenantDbTransaction(prisma, tx => tx.conceptArchive.update({ where: { id: archiveId }, data: { budgetUsage: json({ ...usage, searchExpansions: usage.searchExpansions + ranked.expansions }) } }))
  const byId = new Map(cards.map(card => [card.id, card]))
  const results = ranked.results.map(result => {
    const path: Array<{ id: string; title: string; status: string }> = []
    let current: any = result.card
    for (let step = 0; step < 8 && current; step++) {
      path.unshift({ id: current.id, title: current.title, status: current.status })
      const parentId = current.parentCardIds?.[0]
      current = parentId ? byId.get(parentId) : undefined
    }
    return { ...result, path }
  })
  await logEvent('ConceptArchivePathfinderSearched', 'ConceptArchive', archiveId, userId, { query: parsed.query, expansions: ranked.expansions })
  return { ...ranked, results, budget: { config: budget, usage: { ...usage, searchExpansions: usage.searchExpansions + ranked.expansions } } }
}

export async function listProposals(studioId: string, status?: string) {
  await studioOrThrow(studioId)
  return { items: await prisma.studioProposal.findMany({ where: { studioId, ...tenantWhere(), ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 }) }
}

export async function createProposal(studioId: string, input: unknown, userId: string) {
  const parsed = createProposalSchema.parse(input)
  await studioOrThrow(studioId)
  const archiveId = typeof parsed.scopeRef.archiveId === 'string' ? parsed.scopeRef.archiveId : undefined
  const proposal = await withTenantDbTransaction(prisma, async tx => {
    const archive = archiveId ? await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() } }) : null
    if (archiveId && !archive) throw new NotFoundError('ConceptArchive', archiveId)
    if (archive && archive.studioId !== studioId) throw new ConflictError('The proposal archive does not belong to the selected studio.')
    if (archive) {
      const budget = budgetOf(archive.budgetConfig)
      const usage = usageOf(archive.budgetUsage)
      if (usage.proposals >= budget.maxProposals) throw new ConflictError(`Archive proposal budget exhausted (${budget.maxProposals}).`)
      const created = await tx.studioProposal.create({ data: { studioId, scopeType: parsed.scopeType, scopeRef: json(parsed.scopeRef), kind: parsed.kind, payload: json(parsed.payload), baseRevision: parsed.baseRevision ?? archive.axesRevision, authorType: parsed.authorType, authorId: userId, agentRole: parsed.agentRole ?? null, traceId: parsed.traceId ?? null, expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null, tenantId: tenantId() } })
      await tx.conceptArchive.update({ where: { id: archive.id }, data: { budgetUsage: json({ ...usage, proposals: usage.proposals + 1 }) } })
      return created
    }
    return tx.studioProposal.create({ data: { studioId, scopeType: parsed.scopeType, scopeRef: json(parsed.scopeRef), kind: parsed.kind, payload: json(parsed.payload), baseRevision: parsed.baseRevision ?? null, authorType: parsed.authorType, authorId: userId, agentRole: parsed.agentRole ?? null, traceId: parsed.traceId ?? null, expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null, tenantId: tenantId() } })
  })
  await logEvent('StudioProposalCreated', 'StudioProposal', proposal.id, userId, { studioId, scopeType: proposal.scopeType, kind: proposal.kind })
  return proposal
}

export async function decideProposal(proposalId: string, decision: 'ACCEPTED' | 'REJECTED', userId: string, editedPayload?: Record<string, unknown>, note?: string) {
  const result = await withTenantDbTransaction(prisma, async tx => {
    const proposal = await tx.studioProposal.findFirst({ where: { id: proposalId, ...tenantWhere() }, include: { studio: true } })
    if (!proposal) throw new NotFoundError('StudioProposal', proposalId)
    if (proposal.status !== 'PENDING') throw new ConflictError(`Proposal is already ${proposal.status}.`)
    if (proposal.expiresAt && proposal.expiresAt <= new Date()) {
      await tx.studioProposal.update({ where: { id: proposalId }, data: { status: 'EXPIRED', decidedAt: new Date(), decidedById: userId } })
      throw new ConflictError('Proposal has expired.')
    }
    const archiveId = typeof (proposal.scopeRef as any).archiveId === 'string' ? (proposal.scopeRef as any).archiveId : undefined
    if (archiveId && proposal.baseRevision != null) {
      const archive = await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() } })
      if (!archive) throw new NotFoundError('ConceptArchive', archiveId)
      if (archive.studioId !== proposal.studioId) throw new ConflictError('The proposal archive does not belong to its studio.')
      if (archive.axesRevision !== proposal.baseRevision) {
        const stale = await tx.studioProposal.update({ where: { id: proposalId }, data: { status: 'STALE', decidedAt: new Date(), decidedById: userId, decisionNote: `Base revision ${proposal.baseRevision} is no longer current.` } })
        return stale
      }
    }
    if (decision === 'ACCEPTED') {
      if (proposal.scopeType === 'CONCEPT_CARD' && proposal.kind === 'CREATE') {
        const archiveIdForCreate = archiveId
        if (!archiveIdForCreate) throw new ValidationError('Concept card proposal must reference an archiveId.')
        const archive = await tx.conceptArchive.findFirst({ where: { id: archiveIdForCreate, ...tenantWhere() } })
        if (!archive) throw new NotFoundError('ConceptArchive', archiveIdForCreate)
        if (archive.studioId !== proposal.studioId) throw new ConflictError('The proposal archive does not belong to its studio.')
        const cardInput = stageCardSchema.parse(editedPayload ?? proposal.payload)
        await stageCardInTx(tx, archive, { ...cardInput, authorType: 'AGENT' }, userId)
      } else if (proposal.scopeType === 'CONCEPT_CARD' && ['UPDATE', 'MUTATE', 'PROMOTE'].includes(proposal.kind)) {
        const ref = proposal.scopeRef as Record<string, unknown>
        const targetCardId = typeof ref.cardId === 'string' ? ref.cardId : undefined
        if (!targetCardId || !archiveId) throw new ValidationError('Concept card proposal must reference an archiveId and cardId.')
        const archive = await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() } })
        if (!archive) throw new NotFoundError('ConceptArchive', archiveId)
        if (archive.studioId !== proposal.studioId) throw new ConflictError('The proposal archive does not belong to its studio.')
        const target = await tx.conceptCard.findFirst({ where: { id: targetCardId, archiveId, ...tenantWhere() } })
        if (!target) throw new NotFoundError('ConceptCard', targetCardId)
        const payload = (editedPayload ?? proposal.payload) as Record<string, unknown>
        if (proposal.kind === 'PROMOTE') {
          if (!['ELITE', 'PROMOTED'].includes(target.status) && !target.pinned) throw new ConflictError('Only an elite or pinned card can be promoted.')
          await tx.conceptCard.update({ where: { id: target.id }, data: { status: 'PROMOTED', promotedRef: json(payload.promotedRef ?? {}), operatorNote: typeof payload.note === 'string' ? payload.note : target.operatorNote } })
          await appendArchiveEvent(tx, { archiveId, cardId: target.id, eventType: 'CARD_PROMOTED', actorType: 'HUMAN', actorId: userId, payload: { proposalId } })
        } else if (proposal.kind === 'UPDATE') {
          const body = payload.body === undefined ? undefined : conceptCardBodySchema.parse(payload.body)
          const fitness = payload.fitness === undefined ? undefined : stageCardSchema.shape.fitness.parse(payload.fitness)
          const title = payload.title === undefined ? target.title : String(payload.title)
          const summary = payload.summary === undefined ? target.summary : String(payload.summary)
          const compositeScore = fitness ? compositeScoreOf(fitness, archive.fitnessConfig as Record<string, number>) : target.compositeScore
          await tx.conceptCard.update({ where: { id: target.id }, data: { title: title.trim().slice(0, 240), summary: summary.trim().slice(0, 2000), ...(body ? { body: json(body) } : {}), ...(fitness ? { fitness: json(fitness), compositeScore } : {}) } })
          await appendArchiveEvent(tx, { archiveId, cardId: target.id, eventType: 'CARD_UPDATED', actorType: 'HUMAN', actorId: userId, payload: { proposalId } })
        } else {
          const cardInput = stageCardSchema.parse({ ...payload, parentCardIds: [...(Array.isArray(payload.parentCardIds) ? payload.parentCardIds : []), target.id], authorType: 'AGENT', operator: 'MUTATE' })
          await stageCardInTx(tx, archive, cardInput, userId)
        }
      } else if (proposal.scopeType === 'ARCHIVE_CELL' && proposal.kind === 'SWAP') {
        const ref = proposal.scopeRef as Record<string, unknown>
        const refArchiveId = typeof ref.archiveId === 'string' ? ref.archiveId : undefined
        const cellKey = typeof ref.cellKey === 'string' ? ref.cellKey : undefined
        const candidateCardId = typeof ref.candidateCardId === 'string' ? ref.candidateCardId : undefined
        const expectedEliteId = typeof ref.currentEliteId === 'string' ? ref.currentEliteId : null
        if (!refArchiveId || !cellKey || !candidateCardId) throw new ValidationError('Swap proposal is missing its archive cell reference.')
        const cell = await tx.archiveCellState.findUnique({ where: { archiveId_axesRevision_cellKey: { archiveId: refArchiveId, axesRevision: proposal.baseRevision ?? 1, cellKey } } })
        if (!cell || cell.killed || cell.eliteCardId !== expectedEliteId) throw new ConflictError('The archive cell changed since this swap was proposed. Reopen it from the current archive state.')
        const candidate = await tx.conceptCard.findFirst({ where: { id: candidateCardId, archiveId: refArchiveId, status: 'STAGED' } })
        if (!candidate) throw new NotFoundError('ConceptCard', candidateCardId)
        const fenced = await tx.archiveCellState.updateMany({ where: { id: cell.id, eliteCardId: expectedEliteId }, data: { eliteCardId: candidateCardId } })
        if (fenced.count !== 1) throw new ConflictError('The archive cell changed while the swap was being approved.')
        if (expectedEliteId) await tx.conceptCard.update({ where: { id: expectedEliteId }, data: { status: 'DISPLACED' } })
        await tx.conceptCard.update({ where: { id: candidateCardId }, data: { status: 'ELITE' } })
        await appendArchiveEvent(tx, { archiveId: refArchiveId, cardId: candidateCardId, cellKey, eventType: 'CARD_SWAP_ACCEPTED', actorType: 'HUMAN', actorId: userId, payload: { displacedCardId: expectedEliteId, proposalId } })
      } else {
        throw new ValidationError('This proposal kind is not executable yet. Keep it pending until its dedicated apply verb is available.')
      }
    }
    return tx.studioProposal.update({ where: { id: proposalId }, data: { status: decision, decidedAt: new Date(), decidedById: userId, decisionNote: note ?? null, ...(editedPayload ? { editedPayload: json(editedPayload) } : {}) } })
  })
  await logEvent('StudioProposalDecided', 'StudioProposal', proposalId, userId, { status: result.status })
  return result
}

export async function rebaseProposal(proposalId: string, payload: Record<string, unknown>, userId: string) {
  const original = await prisma.studioProposal.findFirst({ where: { id: proposalId, ...tenantWhere() } })
  if (!original) throw new NotFoundError('StudioProposal', proposalId)
  if (original.status !== 'STALE') throw new ConflictError('Only a stale proposal can be rebased.')
  const archiveId = typeof (original.scopeRef as any).archiveId === 'string' ? (original.scopeRef as any).archiveId : undefined
  const rebased = await withTenantDbTransaction(prisma, async tx => {
    const archive = archiveId ? await tx.conceptArchive.findFirst({ where: { id: archiveId, ...tenantWhere() } }) : null
    if (archiveId && !archive) throw new NotFoundError('ConceptArchive', archiveId)
    if (archive && archive.studioId !== original.studioId) throw new ConflictError('The proposal archive does not belong to its studio.')
    const budget = archive ? budgetOf(archive.budgetConfig) : null
    const usage = archive ? usageOf(archive.budgetUsage) : null
    if (budget && usage && usage.proposals >= budget.maxProposals) throw new ConflictError(`Archive proposal budget exhausted (${budget.maxProposals}).`)
    const created = await tx.studioProposal.create({ data: { studioId: original.studioId, scopeType: original.scopeType, scopeRef: json(original.scopeRef), kind: original.kind, payload: json(payload), baseRevision: archive?.axesRevision, authorType: original.authorType, authorId: userId, agentRole: original.agentRole, traceId: original.traceId, rebaseOfId: original.id, tenantId: tenantId() } })
    if (archive && usage) await tx.conceptArchive.update({ where: { id: archive.id }, data: { budgetUsage: json({ ...usage, proposals: usage.proposals + 1 }) } })
    return created
  })
  await logEvent('StudioProposalRebased', 'StudioProposal', rebased.id, userId, { rebaseOfId: original.id, baseRevision: rebased.baseRevision })
  return rebased
}
