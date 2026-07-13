// Bundle the wgvm CLI (plus @workgraph/vm and @workgraph/engine) into a single
// self-contained ESM file with no third-party runtime dependencies, so the OCI
// image can run it with plain `node` — no pnpm install, no tsx, no registry.
// Node built-ins (including node:sqlite) stay external.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/wgvm.mjs',
  // Keep only node: builtins external; bundle the first-party workspace deps.
  external: ['node:*'],
})

console.log('bundled -> dist/wgvm.mjs')
