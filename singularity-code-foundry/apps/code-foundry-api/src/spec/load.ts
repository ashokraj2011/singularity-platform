import { readFileSync } from 'node:fs'
import yaml from 'yaml'

/**
 * M42.1 — Read a spec file from disk and parse YAML or JSON.
 * Returns raw JS (not yet validated) so the caller can validate +
 * report errors with file context.
 */
export interface LoadedSpec {
  path: string
  yaml: string
  raw: unknown
}

export function loadSpecFile(path: string): LoadedSpec {
  const text = readFileSync(path, 'utf8')
  const raw = yaml.parse(text)
  return { path, yaml: text, raw }
}
