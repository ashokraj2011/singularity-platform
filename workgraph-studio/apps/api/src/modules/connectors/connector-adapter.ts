export interface ConnectorAdapter {
  testConnection(): Promise<{ ok: boolean; error?: string }>
  invoke(operation: string, params: Record<string, unknown>): Promise<unknown>
  listOperations(): OperationDef[]
}

export interface OperationDef {
  id: string
  label: string
  description?: string
  params: ParamDef[]
}

export interface ParamDef {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'json' | 'text'
  required?: boolean
  description?: string
}
