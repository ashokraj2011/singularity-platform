/**
 * M42.2 — Write generated files to disk + emit generation-manifest.json.
 *
 * Pure-fs operation. Returns the manifest body so the receipt can
 * include `generatedArtifacts[]` without a re-read.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256 } from '../spec/hash.js'
import type { GeneratedFile } from './types.js'
import type { ApplicationIr } from '../ir/types.js'

export interface ManifestEntry {
  path: string
  contentHash: string
  fileType: GeneratedFile['fileType']
  generatedBy: string
  protected: boolean
}

export interface WriteResult {
  outputDir: string
  files: ManifestEntry[]
  manifestPath: string
  manifest: {
    generatorVersion: string
    templateVersion: string
    specHash: string
    irHash: string
    generatedAt: string
    files: ManifestEntry[]
  }
}

export function writeFiles(outputDir: string, ir: ApplicationIr, files: GeneratedFile[]): WriteResult {
  mkdirSync(outputDir, { recursive: true })
  const entries: ManifestEntry[] = []
  for (const f of files) {
    const abs = join(outputDir, f.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.content, 'utf8')
    entries.push({
      path: f.path,
      contentHash: sha256(f.content),
      fileType: f.fileType,
      generatedBy: f.generatedBy,
      protected: f.protected,
    })
  }
  const manifest = {
    generatorVersion: ir.meta.generatorVersion,
    templateVersion: ir.meta.templateVersion,
    specHash: ir.meta.specHash,
    irHash: ir.meta.irHash,
    generatedAt: new Date().toISOString(),
    files: entries,
  }
  const manifestPath = 'generation-manifest.json'
  writeFileSync(join(outputDir, manifestPath), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { outputDir, files: entries, manifestPath, manifest }
}
