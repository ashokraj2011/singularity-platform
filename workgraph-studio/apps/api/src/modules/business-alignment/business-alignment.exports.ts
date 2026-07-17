import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { prisma } from '../../lib/prisma'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { currentTenantDbClient, currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { projectSpecPackageSchema } from '../studio/studio-spec.schemas'

export type BusinessExportArtifact = {
  body: Buffer
  contentType: string
  filename: string
}

type ExportDocumentSection = {
  heading: string
  lines: string[]
}

const tenantId = () => currentTenantIdForDb() ?? 'default'
const db = () => currentTenantDbClient() ?? prisma

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : []
}

function safeFilename(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'initiative'
}

async function projectOrThrow(projectId: string) {
  const project = await db().specificationProject.findFirst({ where: { id: projectId, tenantId: tenantId() } })
  if (!project) throw new NotFoundError('SpecificationProject', projectId)
  return project
}

function fitWorksheet(worksheet: ExcelJS.Worksheet) {
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columnCount } }
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173F35' } }
  worksheet.getRow(1).alignment = { vertical: 'middle', wrapText: true }
  worksheet.columns.forEach(column => {
    let width = 12
    column.eachCell?.({ includeEmpty: false }, cell => {
      width = Math.max(width, Math.min(48, String(cell.value ?? '').length + 2))
      cell.alignment = { vertical: 'top', wrapText: true }
    })
    column.width = width
  })
}

async function workbookArtifact(workbook: ExcelJS.Workbook, filename: string): Promise<BusinessExportArtifact> {
  workbook.creator = 'Singularity WorkGraph'
  workbook.created = new Date()
  const body = Buffer.from(await workbook.xlsx.writeBuffer())
  return { body, filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
}

export async function exportTraceabilityMatrix(projectId: string): Promise<BusinessExportArtifact> {
  const project = await projectOrThrow(projectId)
  const [draft, objectives, rows, risks] = await Promise.all([
    db().projectSpecification.findUnique({ where: { projectId } }),
    db().businessObjective.findMany({
      where: { tenantId: tenantId(), OR: [{ studioProjectId: projectId }, { projectLinks: { some: { projectId, tenantId: tenantId() } } }] },
    }),
    db().generationPlanRow.findMany({
      where: { plan: { specificationProjectId: projectId, tenantId: tenantId() } },
      include: {
        milestone: true,
        workItem: {
          include: {
            finalizationRecords: { orderBy: { finalizationGeneration: 'desc' }, take: 1 },
            reconciliationRuns: { include: { verdicts: true }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
      orderBy: [{ planId: 'asc' }, { createdAt: 'asc' }],
    }),
    db().businessRisk.findMany({ where: { studioProjectId: projectId, tenantId: tenantId() }, orderBy: [{ status: 'asc' }, { severity: 'desc' }] }),
  ])
  const source = projectSpecPackageSchema.parse(draft?.package ?? {})
  const objectiveById = new Map(objectives.map(objective => [objective.id, objective]))
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Traceability')
  sheet.addRow([
    'Objective ID', 'Objective', 'Objective status', 'Value score', 'Funding line',
    'Requirement ID', 'Requirement', 'Priority', 'Plan row', 'Milestone',
    'WorkItem ID', 'WorkItem', 'WorkItem status', 'Finalization',
    'Reconciliation', 'Requirement verdict', 'Evidence',
  ])

  for (const requirement of source.requirements) {
    const objectiveIds = requirement.objectiveRefs.length ? requirement.objectiveRefs : ['UNFUNDED']
    const servingRows = rows.filter(row => strings(row.requirementIds).includes(requirement.id))
    const traceRows = servingRows.length ? servingRows : [null]
    for (const objectiveId of objectiveIds) {
      const objective = objectiveById.get(objectiveId)
      for (const row of traceRows) {
        const reconciliation = row?.workItem?.reconciliationRuns[0]
        const verdict = reconciliation?.verdicts.find(item => item.requirementId === requirement.id)
        const finalization = row?.workItem?.finalizationRecords[0]
        sheet.addRow([
          objective?.id ?? objectiveId,
          objective?.title ?? 'Unfunded / no objective',
          objective?.status ?? 'UNASSIGNED',
          objective?.valueScore ?? 0,
          objective?.budgetLineRef ?? '',
          requirement.id,
          requirement.statement,
          requirement.priority,
          row?.rowKey ?? '',
          row?.milestone?.name ?? '',
          row?.workItem?.id ?? '',
          row?.workItem?.title ?? '',
          row?.workItem?.status ?? 'NOT_GENERATED',
          finalization?.status ?? 'NOT_FINALIZED',
          reconciliation ? `${reconciliation.reconciliationState}/${reconciliation.status}` : 'NOT_RECONCILED',
          verdict?.verdict ?? 'NOT_VERIFIED',
          verdict ? JSON.stringify(verdict.evidence) : '',
        ])
      }
    }
  }
  fitWorksheet(sheet)
  const riskSheet = workbook.addWorksheet('Risk register')
  riskSheet.addRow(['Risk ID', 'Category', 'Risk', 'Description', 'Severity', 'Owner', 'Mitigation', 'Status', 'Source type', 'Source ID', 'Source link'])
  risks.forEach(risk => riskSheet.addRow([risk.id, risk.category, risk.title, risk.description, risk.severity, risk.ownerId ?? '', risk.mitigation ?? '', risk.status, risk.sourceType, risk.sourceId, risk.sourceHref ?? '']))
  fitWorksheet(riskSheet)
  const manifest = workbook.addWorksheet('Manifest')
  manifest.addRows([
    ['Field', 'Value'],
    ['Initiative ID', project.id],
    ['Initiative', project.name],
    ['Generated at', new Date().toISOString()],
    ['Source', 'Live WorkGraph records'],
    ['Tenant', tenantId()],
  ])
  fitWorksheet(manifest)
  return workbookArtifact(workbook, `${safeFilename(project.code || project.name)}-traceability.xlsx`)
}

export async function exportSpendByObjective(projectId: string): Promise<BusinessExportArtifact> {
  const project = await projectOrThrow(projectId)
  const [draft, objectives, rows] = await Promise.all([
    db().projectSpecification.findUnique({ where: { projectId } }),
    db().businessObjective.findMany({
      where: { tenantId: tenantId(), OR: [{ studioProjectId: projectId }, { projectLinks: { some: { projectId, tenantId: tenantId() } } }] },
    }),
    db().generationPlanRow.findMany({ where: { plan: { specificationProjectId: projectId, tenantId: tenantId() } }, orderBy: { createdAt: 'asc' } }),
  ])
  const source = projectSpecPackageSchema.parse(draft?.package ?? {})
  const objectivesByRequirement = new Map(source.requirements.map(requirement => [requirement.id, requirement.objectiveRefs]))
  const objectiveById = new Map(objectives.map(objective => [objective.id, objective]))
  const totals = new Map<string, { low: number; high: number; actual: number; tokens: number; rows: Set<string> }>()
  for (const row of rows) {
    const served = [...new Set(strings(row.requirementIds).flatMap(requirementId => objectivesByRequirement.get(requirementId) ?? []))]
    const allocationIds = served.length ? served : ['UNASSIGNED']
    const divisor = allocationIds.length
    for (const objectiveId of allocationIds) {
      const total = totals.get(objectiveId) ?? { low: 0, high: 0, actual: 0, tokens: 0, rows: new Set<string>() }
      total.low += (row.estimatedCostLow ?? 0) / divisor
      total.high += (row.estimatedCostHigh ?? row.estimatedCostLow ?? 0) / divisor
      total.actual += (row.actualCostUsd ?? 0) / divisor
      total.tokens += Math.round((row.estimatedTokens ?? 0) / divisor)
      total.rows.add(row.rowKey)
      totals.set(objectiveId, total)
    }
  }

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Spend by objective')
  sheet.addRow(['Objective ID', 'Objective', 'Owner', 'Value score', 'Funding line', 'Estimated low', 'Estimated high', 'Actual cost', 'Estimated tokens', 'Plan rows', 'Allocation method'])
  for (const [objectiveId, total] of totals) {
    const objective = objectiveById.get(objectiveId)
    sheet.addRow([objectiveId, objective?.title ?? 'Unassigned work', objective?.ownerId ?? '', objective?.valueScore ?? 0, objective?.budgetLineRef ?? '', total.low, total.high, total.actual, total.tokens, [...total.rows].join(', '), 'Even split across served objectives'])
  }
  ;[6, 7, 8].forEach(index => { sheet.getColumn(index).numFmt = '$#,##0.00' })
  fitWorksheet(sheet)
  const summary = workbook.addWorksheet('Initiative envelope')
  summary.addRows([
    ['Field', 'Value'],
    ['Initiative', project.name],
    ['Cost envelope', project.costBudgetUsd ?? 'Not declared'],
    ['Recorded cost used', project.costUsedUsd],
    ['Token budget', project.tokenBudget],
    ['Recorded tokens used', project.tokenUsed],
    ['Generated at', new Date().toISOString()],
  ])
  fitWorksheet(summary)
  return workbookArtifact(workbook, `${safeFilename(project.code || project.name)}-spend-by-objective.xlsx`)
}

function markdownSections(markdown: string): ExportDocumentSection[] {
  const sections: ExportDocumentSection[] = []
  let current: ExportDocumentSection = { heading: 'Readout', lines: [] }
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+)$/)
    if (heading) {
      if (current.lines.length) sections.push(current)
      current = { heading: heading[1], lines: [] }
    } else if (line.trim()) {
      current.lines.push(line.replace(/^[-*]\s+/, ''))
    }
  }
  if (current.lines.length || current.heading) sections.push(current)
  return sections
}

async function renderDocx(title: string, sections: ExportDocumentSection[]): Promise<Buffer> {
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const section of sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }))
    for (const line of section.lines) children.push(new Paragraph({ children: [new TextRun(line)], spacing: { after: 120 } }))
  }
  return Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] }))
}

function renderPdf(title: string, sections: ExportDocumentSection[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 54, left: 54, right: 54 }, info: { Title: title, Author: 'Singularity WorkGraph' } })
    const chunks: Buffer[] = []
    document.on('data', chunk => chunks.push(Buffer.from(chunk)))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    document.fontSize(20).fillColor('#173f35').text(title)
    document.moveDown()
    for (const section of sections) {
      document.fontSize(14).fillColor('#173f35').text(section.heading)
      document.moveDown(0.3)
      for (const line of section.lines) {
        document.fontSize(9.5).fillColor('#26362f').text(line, { lineGap: 2 })
        document.moveDown(0.25)
      }
      document.moveDown(0.7)
    }
    document.end()
  })
}

async function documentArtifact(title: string, sections: ExportDocumentSection[], format: 'docx' | 'pdf', filenameBase: string): Promise<BusinessExportArtifact> {
  return format === 'docx'
    ? { body: await renderDocx(title, sections), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${filenameBase}.docx` }
    : { body: await renderPdf(title, sections), contentType: 'application/pdf', filename: `${filenameBase}.pdf` }
}

export async function exportSignedReadoutArchive(projectId: string, format: 'docx' | 'pdf'): Promise<BusinessExportArtifact> {
  const project = await projectOrThrow(projectId)
  const readouts = await db().businessReadout.findMany({
    where: { studioProjectId: projectId, tenantId: tenantId(), status: 'SIGNED' },
    orderBy: { signedAt: 'asc' },
  })
  const approvalIds = readouts.map(readout => readout.sponsorApprovalId).filter((id): id is string => Boolean(id))
  const approvals = await db().approvalRequest.findMany({ where: { id: { in: approvalIds }, tenantId: tenantId() }, include: { decisions: { orderBy: { decidedAt: 'asc' } } } })
  const approvalById = new Map(approvals.map(approval => [approval.id, approval]))
  const sections: ExportDocumentSection[] = []
  for (const readout of readouts) {
    const approval = readout.sponsorApprovalId ? approvalById.get(readout.sponsorApprovalId) : undefined
    const signature = approval?.decisions.find(decision => ['APPROVED', 'APPROVED_WITH_CONDITIONS'].includes(decision.decision))
    sections.push({
      heading: `${readout.kind} readout · ${readout.signedAt?.toISOString().slice(0, 10) ?? 'signed'}`,
      lines: [
        `Content hash: sha256:${readout.contentHash}`,
        `Signed by: ${signature?.decidedById ?? 'Unknown'}`,
        `Signed at: ${signature?.decidedAt.toISOString() ?? readout.signedAt?.toISOString() ?? 'Unknown'}`,
        `Approval request: ${readout.sponsorApprovalId ?? 'Unknown'}`,
        ...markdownSections(readout.renderedMarkdown).flatMap(section => [section.heading, ...section.lines]),
      ],
    })
  }
  if (!sections.length) sections.push({ heading: 'No signed readouts', lines: ['This initiative has no sponsor-signed readout yet.'] })
  return documentArtifact(`${project.name} · Signed business readouts`, sections, format, `${safeFilename(project.code || project.name)}-signed-readouts`)
}

export async function exportDecisionLog(projectId: string, format: 'docx' | 'pdf'): Promise<BusinessExportArtifact> {
  const project = await projectOrThrow(projectId)
  const dossiers = await db().decisionDossier.findMany({ where: { projectId, tenantId: tenantId() }, include: { options: true }, orderBy: { createdAt: 'asc' } })
  const approvalIds = dossiers.map(dossier => dossier.approvalRequestId).filter((id): id is string => Boolean(id))
  const approvals = await db().approvalRequest.findMany({ where: { id: { in: approvalIds }, tenantId: tenantId() }, include: { decisions: { orderBy: { decidedAt: 'asc' } } } })
  const approvalById = new Map(approvals.map(approval => [approval.id, approval]))
  const sections = dossiers.map(dossier => {
    const accepted = dossier.options.find(option => option.id === dossier.acceptedOptionId)
    const approval = dossier.approvalRequestId ? approvalById.get(dossier.approvalRequestId) : undefined
    return {
      heading: dossier.title,
      lines: [
        `Status: ${dossier.status}`,
        `Problem: ${dossier.problem}`,
        `Accepted option: ${accepted?.title ?? 'No option accepted'}`,
        `Author: ${dossier.createdById}; decision owner: ${dossier.decidedById ?? 'Pending'}`,
        `Approval: ${approval?.status ?? 'Not requested'} (${approval?.id ?? 'n/a'})`,
        ...dossier.options.map(option => `${option.status === 'REJECTED' ? 'Rejected' : 'Option'}: ${option.title} — ${option.summary}; trade-offs: ${JSON.stringify(option.tradeoffs)}`),
        ...(approval?.decisions.map(decision => `Approval decision: ${decision.decision} by ${decision.decidedById} at ${decision.decidedAt.toISOString()}${decision.notes ? ` — ${decision.notes}` : ''}`) ?? []),
      ],
    }
  })
  if (!sections.length) sections.push({ heading: 'No decisions', lines: ['This initiative has no decision dossiers yet.'] })
  return documentArtifact(`${project.name} · Decision log`, sections, format, `${safeFilename(project.code || project.name)}-decision-log`)
}

export function assertBusinessDocumentFormat(value: unknown): 'docx' | 'pdf' {
  if (value !== 'docx' && value !== 'pdf') throw new ValidationError('Export format must be docx or pdf')
  return value
}

export async function withBusinessExportTenant<T>(operation: () => Promise<T>): Promise<T> {
  return withTenantDbTransaction(prisma, operation, tenantId())
}
