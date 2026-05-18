/**
 * M42.2 — Generator dispatch.
 *
 * Selects a CodeGenerator from the IR's application.framework and
 * invokes it. New stacks plug in by registering here; the rest of the
 * Foundry doesn't have to know about them.
 */
import type { ApplicationIr } from '../ir/types.js'
import { expressGenerator } from './express/index.js'
import { fastapiGenerator } from './fastapi/index.js'
import { springbootGenerator } from './springboot/index.js'
import type { CodeGenerator, GeneratedFile } from './types.js'

const REGISTRY: CodeGenerator[] = [springbootGenerator, fastapiGenerator, expressGenerator]

export function selectGenerator(ir: ApplicationIr): CodeGenerator {
  const match = REGISTRY.find((g) => g.supports(ir))
  if (!match) {
    throw new Error(
      `No generator registered for language=${ir.application.language}, framework=${ir.application.framework}`,
    )
  }
  return match
}

export function generate(ir: ApplicationIr): GeneratedFile[] {
  return selectGenerator(ir).generate(ir)
}

export { REGISTRY as generators }
