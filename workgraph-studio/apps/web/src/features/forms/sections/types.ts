/**
 * Form section type system — shared between Artifact Designer, NodeInspector
 * (HUMAN_TASK / APPROVAL / CONSUMABLE_CREATION), and the runtime form panel.
 */

export type SectionType =
  | 'RICH_TEXT'
  | 'STRUCTURED_FIELDS'
  | 'TABLE'
  | 'CODE_BLOCK'
  | 'SIGNATURE'
  | 'CHECKLIST'
  | 'FILE_ATTACHMENT'

export type FilledBy = 'AGENT' | 'HUMAN' | 'SYSTEM' | 'ANY'

export type FieldType = 'text' | 'number' | 'date' | 'email' | 'url' | 'boolean' | 'enum'

export type FieldDef = {
  key:      string
  label:    string
  type:     FieldType | string
  required: boolean
  options?: string[]
}

export type ChecklistItem = {
  id:    string
  label: string
}

export type FormSection = {
  id:             string
  title:          string
  type:           SectionType
  required:       boolean
  filledBy:       FilledBy
  description?:   string
  placeholder?:   string
  defaultContent?: string
  // STRUCTURED_FIELDS
  fields?:        FieldDef[]
  // TABLE
  columns?:       string[]
  // CODE_BLOCK
  language?:      string
  // CHECKLIST
  items?:         ChecklistItem[]
}

/** Back-compat alias: artifact code still references this name. */
export type ArtifactSection = FormSection

// ── Helpers ──────────────────────────────────────────────────────────────────

export function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function newSection(type: SectionType, title?: string): FormSection {
  return {
    id:       uid(),
    title:    title ?? defaultTitleFor(type),
    type,
    required: true,
    filledBy: 'ANY',
  }
}

export function defaultTitleFor(type: SectionType): string {
  switch (type) {
    case 'RICH_TEXT':         return 'Rich Text'
    case 'STRUCTURED_FIELDS': return 'Structured Fields'
    case 'TABLE':             return 'Table'
    case 'CODE_BLOCK':        return 'Code Block'
    case 'SIGNATURE':         return 'Signature'
    case 'CHECKLIST':         return 'Checklist'
    case 'FILE_ATTACHMENT':   return 'File Attachment'
  }
}
