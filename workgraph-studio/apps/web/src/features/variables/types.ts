/**
 * Shared variable types used by the Team Variables page, the Studio Variables
 * tab, and the VariablePicker.
 */

export type VarType = 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON'

/**
 * GLOBAL    — same fixed value across every workflow instance on the team.
 * INSTANCE  — declared once at team level; each running instance gets its own
 *             value (defaulted to the team value, overrideable per instance).
 */
export type VarScope = 'GLOBAL' | 'INSTANCE'

export type TeamVariable = {
  id:           string
  teamId:       string
  key:          string
  label?:       string
  type:         VarType
  scope:        VarScope
  value:        unknown
  description?: string
}

/**
 * The merged shape returned by GET /workflow-instances/:id/globals.  For each
 * team variable, lists its team-default, the current per-instance value, and
 * whether it's editable (INSTANCE scope) or read-only (GLOBAL scope).
 */
export type InstanceGlobalEntry = {
  key:          string
  label:        string | null
  type:         VarType
  scope:        VarScope
  teamDefault:  unknown
  currentValue: unknown
  description:  string | null
  editable:     boolean
}

export type TemplateVariableScope = 'INPUT' | 'CONSTANT'

export type TemplateVariableDef = {
  key:          string
  label?:       string
  type:         VarType
  defaultValue?: unknown
  description?: string
  scope:        TemplateVariableScope
}

export type VarPickerCategory =
  | 'globals'      // team globals — globals.X
  | 'vars'         // template variables — vars.X
  | 'output'       // upstream node outputs — output.X
  | 'context'      // free-form context paths — context.X
  | 'params'       // legacy params — params.X

export type VarPickerEntry = {
  category:    VarPickerCategory
  /** Path string the user can paste, e.g. "globals.companyName" */
  path:        string
  /** Optional friendly label shown beside the path */
  label?:      string
  /** Optional type hint for badge */
  type?:       VarType
  /** Optional source description */
  source?:     string
}
