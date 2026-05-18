import type { ApplicationIr } from '../ir/types.js'

export type FileKind = 'source' | 'test' | 'config' | 'doc' | 'contract' | 'manifest'

export interface GeneratedFile {
  path: string
  content: string
  fileType: FileKind
  generatedBy: string  // template id
  protected: boolean   // true if every byte is inside a generated:protected region
}

export interface GenerationOptions {
  /** Absolute path to write into. Generator creates the dir if needed. */
  outputDir: string
}

export interface CodeGenerator {
  /** Stack identifier — 'springboot' | 'fastapi' | 'express'. */
  id: string
  /** Returns true when this generator matches the IR. */
  supports(ir: ApplicationIr): boolean
  /** Generate (do not write) files for the given IR. */
  generate(ir: ApplicationIr): GeneratedFile[]
}
