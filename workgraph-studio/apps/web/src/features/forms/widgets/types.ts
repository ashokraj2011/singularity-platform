/**
 * Task-form widget system.
 *
 * One widget = one input (or one display element).  Forms are flat, ordered
 * lists of widgets; each carries its own label, key, required flag, and any
 * type-specific config.  This is a deliberate departure from the
 * section-based shape used by Artifact Studio — task forms are about
 * collecting data, artifacts are about composing documents.
 */

export type WidgetType =
  // Input widgets (carry a value in `formData[widget.key]`)
  | 'SHORT_TEXT'
  | 'LONG_TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'EMAIL'
  | 'URL'
  | 'PHONE'
  | 'BOOLEAN'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'CHECKLIST'
  | 'SIGNATURE'
  | 'FILE_UPLOAD'
  // Display-only widgets (no value, just structure / guidance)
  | 'INSTRUCTIONS'
  | 'HEADING'
  | 'DIVIDER'

export type SelectOption = { value: string; label: string }
export type ChecklistItem = { id: string; label: string }

export type FormWidget = {
  /** Stable client-side id (also serves as React key). */
  id:        string
  type:      WidgetType
  /** Identifier used as the key in `formData` for value-carrying widgets.
   *  Must be a valid identifier; auto-generated from label if absent. */
  key?:      string
  label?:    string
  required?: boolean
  helpText?: string
  /** Hint text shown inside the input. */
  placeholder?:  string
  defaultValue?: unknown

  // ── Type-specific config ────────────────────────────────────────────────
  /** SELECT, MULTI_SELECT */
  options?: SelectOption[]
  /** CHECKLIST */
  items?:   ChecklistItem[]
  /** INSTRUCTIONS — markdown-ish body */
  content?: string
  /** HEADING — visual hierarchy */
  level?:   1 | 2 | 3
  /** NUMBER constraints */
  min?:     number
  max?:     number
  step?:    number
  /** LONG_TEXT row count */
  rows?:    number
  /** FILE_UPLOAD — restrict to a comma-separated list of mimetypes */
  accept?:  string
  /** FILE_UPLOAD — allow multiple files */
  multiple?: boolean
}

// ── Catalog (drives the "Add widget" picker + per-type defaults) ─────────────

export type WidgetCatalogEntry = {
  type:        WidgetType
  label:       string
  description: string
  /** Carries a value under formData[widget.key]?  False for display-only. */
  hasValue:    boolean
  /** Default sample of the widget at creation time. */
  build:       () => Omit<FormWidget, 'id'>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Convert a label like "Customer email" → "customer_email". */
export function deriveKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    || `field_${uid()}`
}

export function newWidget(type: WidgetType): FormWidget {
  const entry = WIDGET_CATALOG.find(c => c.type === type)
  if (!entry) throw new Error(`Unknown widget type: ${type}`)
  return { id: uid(), ...entry.build() }
}

export function widgetHasValue(type: WidgetType): boolean {
  return WIDGET_CATALOG.find(c => c.type === type)?.hasValue ?? false
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  {
    type: 'SHORT_TEXT', label: 'Short text', description: 'Single-line text', hasValue: true,
    build: () => ({ type: 'SHORT_TEXT', label: 'Short text', key: 'short_text', required: false }),
  },
  {
    type: 'LONG_TEXT', label: 'Long text', description: 'Multi-line text', hasValue: true,
    build: () => ({ type: 'LONG_TEXT', label: 'Long text', key: 'long_text', required: false, rows: 4 }),
  },
  {
    type: 'NUMBER', label: 'Number', description: 'Numeric input', hasValue: true,
    build: () => ({ type: 'NUMBER', label: 'Number', key: 'number', required: false }),
  },
  {
    type: 'DATE', label: 'Date', description: 'Date picker', hasValue: true,
    build: () => ({ type: 'DATE', label: 'Date', key: 'date', required: false }),
  },
  {
    type: 'EMAIL', label: 'Email', description: 'Email address', hasValue: true,
    build: () => ({ type: 'EMAIL', label: 'Email', key: 'email', required: false }),
  },
  {
    type: 'URL', label: 'URL', description: 'Web link', hasValue: true,
    build: () => ({ type: 'URL', label: 'URL', key: 'url', required: false }),
  },
  {
    type: 'PHONE', label: 'Phone', description: 'Phone number', hasValue: true,
    build: () => ({ type: 'PHONE', label: 'Phone', key: 'phone', required: false }),
  },
  {
    type: 'BOOLEAN', label: 'Yes / No', description: 'Single checkbox', hasValue: true,
    build: () => ({ type: 'BOOLEAN', label: 'Confirm', key: 'confirm', required: false, defaultValue: false }),
  },
  {
    type: 'SELECT', label: 'Single-select', description: 'Pick one from a list', hasValue: true,
    build: () => ({
      type: 'SELECT', label: 'Pick one', key: 'choice', required: false,
      options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }],
    }),
  },
  {
    type: 'MULTI_SELECT', label: 'Multi-select', description: 'Pick many from a list', hasValue: true,
    build: () => ({
      type: 'MULTI_SELECT', label: 'Pick many', key: 'choices', required: false,
      options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }],
    }),
  },
  {
    type: 'CHECKLIST', label: 'Checklist', description: 'Tick off items', hasValue: true,
    build: () => ({
      type: 'CHECKLIST', label: 'Checklist', key: 'checklist', required: false,
      items: [{ id: uid(), label: 'First item' }, { id: uid(), label: 'Second item' }],
    }),
  },
  {
    type: 'SIGNATURE', label: 'Signature', description: 'Typed signature with timestamp', hasValue: true,
    build: () => ({ type: 'SIGNATURE', label: 'Sign here', key: 'signature', required: true }),
  },
  {
    type: 'FILE_UPLOAD', label: 'File upload', description: 'Attach file(s)', hasValue: true,
    build: () => ({ type: 'FILE_UPLOAD', label: 'Attachments', key: 'attachments', required: false, multiple: true }),
  },
  {
    type: 'INSTRUCTIONS', label: 'Instructions', description: 'Display-only guidance text', hasValue: false,
    build: () => ({ type: 'INSTRUCTIONS', content: 'Add guidance for the assignee here.' }),
  },
  {
    type: 'HEADING', label: 'Heading', description: 'Section heading', hasValue: false,
    build: () => ({ type: 'HEADING', label: 'Heading', level: 2 }),
  },
  {
    type: 'DIVIDER', label: 'Divider', description: 'Horizontal separator', hasValue: false,
    build: () => ({ type: 'DIVIDER' }),
  },
]
