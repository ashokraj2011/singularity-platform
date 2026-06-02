/**
 * Standard artifact-template catalog seed.
 *
 * Seeds a reusable set of PUBLISHED ArtifactTemplate rows (Test Report, Design
 * Document, Requirements/Acceptance Spec, Release & Rollback Plan, Risk
 * Assessment, ADR, Ops Runbook) with full section skeletons. These surface in
 * the artifact-templates API/UI for operators and agents to reuse.
 *
 * Idempotent: upsert by stable id with `update: {}`, so re-running never
 * clobbers an operator's later edits. Imported by prisma/seed.ts (fresh
 * installs) and runnable standalone (`ts-node prisma/seed-artifact-templates.ts`)
 * to backfill an existing database.
 *
 * Section/party shapes match the create schema in
 * src/modules/artifact/artifact-templates.router.ts.
 */
import { PrismaClient } from '@prisma/client'

type SectionType =
  | 'RICH_TEXT' | 'STRUCTURED_FIELDS' | 'TABLE' | 'CODE_BLOCK'
  | 'SIGNATURE' | 'CHECKLIST' | 'FILE_ATTACHMENT'

interface Section {
  id: string
  title: string
  type: SectionType
  required?: boolean
  filledBy?: 'AGENT' | 'HUMAN' | 'SYSTEM' | 'ANY'
  description?: string
  placeholder?: string
  fields?: Array<{ key: string; label: string; type: string; required: boolean; options?: string[] }>
  columns?: string[]
  items?: Array<{ id: string; label: string }>
}

interface Party {
  id: string
  name: string
  role: 'AGENT' | 'HUMAN' | 'SYSTEM'
  required?: boolean
  description?: string
}

interface StandardTemplate {
  id: string
  name: string
  description: string
  type: 'CONTRACT' | 'DELIVERABLE' | 'SPECIFICATION' | 'APPROVAL_BRIEF' | 'HANDOFF' | 'REPORT'
  sections: Section[]
  parties?: Party[]
  category: string
}

const rich = (id: string, title: string, description: string, filledBy: Section['filledBy'] = 'ANY'): Section =>
  ({ id, title, type: 'RICH_TEXT', required: true, filledBy, description })

const signoff = (id: string): Section =>
  ({ id, title: 'Sign-off', type: 'SIGNATURE', required: true, filledBy: 'HUMAN', description: 'Reviewer approval / sign-off.' })

export const STANDARD_ARTIFACT_TEMPLATES: StandardTemplate[] = [
  {
    id: 'tmpl-test-report',
    name: 'Test Report',
    description: 'Summary of a test run: scope, results, defects, and sign-off.',
    type: 'REPORT',
    category: 'qa',
    sections: [
      rich('tmpl-test-report-summary', 'Summary', 'One-paragraph verdict: what was tested and the overall outcome.'),
      {
        id: 'tmpl-test-report-scope', title: 'Scope & Environment', type: 'STRUCTURED_FIELDS', required: true, filledBy: 'ANY',
        description: 'What was under test and where.',
        fields: [
          { key: 'component', label: 'Component / service', type: 'string', required: true },
          { key: 'version', label: 'Version / commit', type: 'string', required: true },
          { key: 'environment', label: 'Environment', type: 'string', required: true },
          { key: 'test_date', label: 'Test date', type: 'date', required: true },
        ],
      },
      {
        id: 'tmpl-test-report-results', title: 'Test Results', type: 'TABLE', required: true, filledBy: 'ANY',
        description: 'Per-suite results.',
        columns: ['Suite', 'Total', 'Passed', 'Failed', 'Skipped', 'Pass rate'],
      },
      {
        id: 'tmpl-test-report-coverage', title: 'Coverage', type: 'STRUCTURED_FIELDS', required: false, filledBy: 'ANY',
        fields: [
          { key: 'line_coverage', label: 'Line coverage %', type: 'number', required: false },
          { key: 'branch_coverage', label: 'Branch coverage %', type: 'number', required: false },
        ],
      },
      {
        id: 'tmpl-test-report-defects', title: 'Defects / Failures', type: 'TABLE', required: false, filledBy: 'ANY',
        description: 'Failures found, with severity and disposition.',
        columns: ['ID', 'Severity', 'Description', 'Status'],
      },
      signoff('tmpl-test-report-signoff'),
    ],
    parties: [
      { id: 'tmpl-test-report-party-qa', name: 'QA Lead', role: 'HUMAN', required: true, description: 'Signs off the test outcome.' },
    ],
  },
  {
    id: 'tmpl-design-document',
    name: 'Design Document',
    description: 'Technical design: context, architecture, components, trade-offs, and risks.',
    type: 'SPECIFICATION',
    category: 'design',
    sections: [
      rich('tmpl-design-context', 'Context & Goals', 'Problem statement, goals, and non-goals.', 'AGENT'),
      rich('tmpl-design-architecture', 'Architecture Overview', 'High-level approach and key flows (diagram link / description).', 'AGENT'),
      {
        id: 'tmpl-design-components', title: 'Components & Responsibilities', type: 'TABLE', required: true, filledBy: 'AGENT',
        columns: ['Component', 'Responsibility', 'Interfaces / dependencies'],
      },
      rich('tmpl-design-data-model', 'Data Model', 'Entities, schemas, and storage decisions.', 'AGENT'),
      rich('tmpl-design-tradeoffs', 'Trade-offs & Alternatives', 'Options considered and why this one was chosen.', 'AGENT'),
      {
        id: 'tmpl-design-risks', title: 'Risks & Open Questions', type: 'CHECKLIST', required: false, filledBy: 'ANY',
        description: 'Known risks and unresolved questions.',
        items: [
          { id: 'tmpl-design-risk-1', label: 'Security / data-protection considerations addressed' },
          { id: 'tmpl-design-risk-2', label: 'Backward compatibility / migration considered' },
          { id: 'tmpl-design-risk-3', label: 'Performance / scale considered' },
        ],
      },
      signoff('tmpl-design-signoff'),
    ],
    parties: [
      { id: 'tmpl-design-party-architect', name: 'Architect', role: 'AGENT', required: true, description: 'Authors the design.' },
      { id: 'tmpl-design-party-reviewer', name: 'Reviewer', role: 'HUMAN', required: true, description: 'Approves the design.' },
    ],
  },
  {
    id: 'tmpl-requirements-spec',
    name: 'Requirements / Acceptance Spec',
    description: 'Goals, functional requirements, acceptance criteria, and scope boundaries.',
    type: 'SPECIFICATION',
    category: 'intake',
    sections: [
      rich('tmpl-req-overview', 'Overview & Goals', 'What we are building and why; success looks like…', 'AGENT'),
      {
        id: 'tmpl-req-functional', title: 'Functional Requirements', type: 'TABLE', required: true, filledBy: 'AGENT',
        columns: ['ID', 'Requirement', 'Priority'],
      },
      {
        id: 'tmpl-req-acceptance', title: 'Acceptance Criteria', type: 'CHECKLIST', required: true, filledBy: 'ANY',
        description: 'Testable conditions that define "done".',
        items: [
          { id: 'tmpl-req-ac-1', label: 'Criterion 1 (replace with a concrete, testable statement)' },
          { id: 'tmpl-req-ac-2', label: 'Criterion 2' },
        ],
      },
      rich('tmpl-req-out-of-scope', 'Out of Scope', 'Explicitly excluded items.', 'AGENT'),
      rich('tmpl-req-assumptions', 'Assumptions & Dependencies', 'External dependencies and assumptions made.', 'AGENT'),
      signoff('tmpl-req-signoff'),
    ],
    parties: [
      { id: 'tmpl-req-party-po', name: 'Product Owner', role: 'HUMAN', required: true, description: 'Approves scope & acceptance criteria.' },
    ],
  },
  {
    id: 'tmpl-release-rollback-plan',
    name: 'Release & Rollback Plan',
    description: 'Deployment steps, verification, and a tested rollback path for a release.',
    type: 'DELIVERABLE',
    category: 'release',
    sections: [
      {
        id: 'tmpl-rel-summary', title: 'Release Summary', type: 'STRUCTURED_FIELDS', required: true, filledBy: 'ANY',
        fields: [
          { key: 'version', label: 'Release version', type: 'string', required: true },
          { key: 'target_date', label: 'Target date/window', type: 'string', required: true },
          { key: 'services', label: 'Services affected', type: 'string', required: true },
        ],
      },
      {
        id: 'tmpl-rel-preflight', title: 'Pre-flight Checklist', type: 'CHECKLIST', required: true, filledBy: 'ANY',
        items: [
          { id: 'tmpl-rel-pf-1', label: 'CI green / artifacts built' },
          { id: 'tmpl-rel-pf-2', label: 'Migrations reviewed and reversible' },
          { id: 'tmpl-rel-pf-3', label: 'Stakeholders / on-call notified' },
        ],
      },
      rich('tmpl-rel-deploy', 'Deployment Steps', 'Ordered, copy-pasteable steps to deploy.'),
      {
        id: 'tmpl-rel-verify', title: 'Verification / Smoke Tests', type: 'CHECKLIST', required: true, filledBy: 'ANY',
        items: [
          { id: 'tmpl-rel-vf-1', label: 'Health checks pass' },
          { id: 'tmpl-rel-vf-2', label: 'Key user flow verified' },
        ],
      },
      rich('tmpl-rel-rollback', 'Rollback Plan', 'Exact steps to revert, with the trigger conditions for rolling back.'),
      signoff('tmpl-rel-signoff'),
    ],
    parties: [
      { id: 'tmpl-rel-party-devops', name: 'Release Owner', role: 'HUMAN', required: true, description: 'Owns the release & rollback decision.' },
    ],
  },
  {
    id: 'tmpl-risk-assessment',
    name: 'Risk Assessment',
    description: 'Risk register with likelihood/impact, mitigations, and overall rating.',
    type: 'REPORT',
    category: 'governance',
    sections: [
      rich('tmpl-risk-summary', 'Summary', 'Overall risk posture in a sentence or two.'),
      {
        id: 'tmpl-risk-register', title: 'Risk Register', type: 'TABLE', required: true, filledBy: 'ANY',
        columns: ['Risk', 'Likelihood', 'Impact', 'Mitigation', 'Owner'],
      },
      {
        id: 'tmpl-risk-rating', title: 'Overall Risk Rating', type: 'STRUCTURED_FIELDS', required: true, filledBy: 'ANY',
        fields: [
          { key: 'overall_rating', label: 'Overall rating', type: 'enum', required: true, options: ['Low', 'Medium', 'High', 'Critical'] },
        ],
      },
      rich('tmpl-risk-residual', 'Residual Risks & Acceptance', 'Risks remaining after mitigation and who accepts them.'),
      signoff('tmpl-risk-signoff'),
    ],
    parties: [
      { id: 'tmpl-risk-party-approver', name: 'Risk Approver', role: 'HUMAN', required: true, description: 'Accepts residual risk.' },
    ],
  },
  {
    id: 'tmpl-adr',
    name: 'Architecture Decision Record (ADR)',
    description: 'A single architectural decision: context, decision, consequences, alternatives.',
    type: 'SPECIFICATION',
    category: 'design',
    sections: [
      {
        id: 'tmpl-adr-status', title: 'Status', type: 'STRUCTURED_FIELDS', required: true, filledBy: 'ANY',
        fields: [
          { key: 'status', label: 'Status', type: 'enum', required: true, options: ['Proposed', 'Accepted', 'Superseded', 'Deprecated'] },
          { key: 'date', label: 'Date', type: 'date', required: true },
          { key: 'deciders', label: 'Deciders', type: 'string', required: false },
        ],
      },
      rich('tmpl-adr-context', 'Context', 'The forces at play and the problem being solved.', 'AGENT'),
      rich('tmpl-adr-decision', 'Decision', 'The change being made, stated in active voice.', 'AGENT'),
      rich('tmpl-adr-consequences', 'Consequences', 'Resulting trade-offs — positive, negative, and follow-ups.', 'AGENT'),
      rich('tmpl-adr-alternatives', 'Alternatives Considered', 'Other options and why they were not chosen.', 'AGENT'),
    ],
    parties: [],
  },
  {
    id: 'tmpl-ops-runbook',
    name: 'Ops Runbook',
    description: 'Operational handoff: how to run, monitor, and troubleshoot a service.',
    type: 'HANDOFF',
    category: 'ops',
    sections: [
      rich('tmpl-runbook-overview', 'Overview', 'What the service does and its place in the system.'),
      rich('tmpl-runbook-architecture', 'Architecture & Dependencies', 'Upstream/downstream dependencies and data stores.'),
      {
        id: 'tmpl-runbook-routine', title: 'Routine Operations', type: 'CHECKLIST', required: false, filledBy: 'ANY',
        items: [
          { id: 'tmpl-runbook-op-1', label: 'How to deploy / restart' },
          { id: 'tmpl-runbook-op-2', label: 'How to scale' },
          { id: 'tmpl-runbook-op-3', label: 'Backups / data retention' },
        ],
      },
      {
        id: 'tmpl-runbook-monitoring', title: 'Monitoring & Alerts', type: 'TABLE', required: false, filledBy: 'ANY',
        columns: ['Alert', 'Threshold', 'Action'],
      },
      rich('tmpl-runbook-incident', 'Incident Response / Troubleshooting', 'Common failures and step-by-step remediation.'),
      {
        id: 'tmpl-runbook-escalation', title: 'Escalation Contacts', type: 'TABLE', required: false, filledBy: 'ANY',
        columns: ['Role', 'Contact', 'Hours'],
      },
    ],
    parties: [],
  },
]

export async function seedArtifactTemplates(prisma: PrismaClient, createdById: string): Promise<void> {
  for (const t of STANDARD_ARTIFACT_TEMPLATES) {
    await prisma.artifactTemplate.upsert({
      where: { id: t.id },
      update: {}, // create-once: never clobber operator edits on re-seed
      create: {
        id: t.id,
        name: t.name,
        description: t.description,
        type: t.type,
        status: 'PUBLISHED',
        version: 1,
        sections: t.sections as unknown as object,
        parties: (t.parties ?? []) as unknown as object,
        metadata: { category: t.category, seeded: true } as unknown as object,
        createdById,
      },
    })
  }
  console.log(`Seeded ${STANDARD_ARTIFACT_TEMPLATES.length} standard artifact templates`)
}

// Standalone runner — backfill an existing database:
//   ts-node prisma/seed-artifact-templates.ts
if (require.main === module) {
  const prisma = new PrismaClient()
  void (async () => {
    const admin =
      (await prisma.user.findUnique({ where: { email: 'admin@workgraph.local' } })) ??
      (await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } }))
    if (!admin) {
      throw new Error('No user found to own the seeded templates (expected admin@workgraph.local). Run the main seed first.')
    }
    await seedArtifactTemplates(prisma, admin.id)
    await prisma.$disconnect()
  })().catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
}
