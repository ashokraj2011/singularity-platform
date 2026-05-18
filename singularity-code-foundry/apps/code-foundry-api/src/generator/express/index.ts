/**
 * M42.2 — Express + TypeScript generator.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ApplicationIr } from '../../ir/types.js'
import { render } from '../templateEngine.js'
import type { CodeGenerator, GeneratedFile } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, '../../templates/express')
const TEMPLATE_VERSION = 'express-template-0.1.0'

function tpl(name: string): string {
  return readFileSync(join(TEMPLATES_DIR, name), 'utf8')
}

export const expressGenerator: CodeGenerator = {
  id: 'express',
  supports(ir) {
    return ir.application.framework === 'express'
  },
  generate(ir): GeneratedFile[] {
    const stampedMeta = { ...ir.meta, templateVersion: TEMPLATE_VERSION }
    const irForRender: ApplicationIr = { ...ir, meta: stampedMeta }
    const hasResilience = ir.dataSources.some(ds => ds.hasResilience)
    const auditClassName = `${ir.application.name.replace(/Service$/, '')}AuditLogger`

    const out: GeneratedFile[] = []
    out.push({
      path: 'package.json',
      content: render(tpl('package.json.hbs'), { ...irForRender, hasResilience }),
      fileType: 'config',
      generatedBy: 'express/package.json.hbs',
      protected: false,
    })
    out.push({
      path: 'tsconfig.json',
      content: render(tpl('tsconfig.json.hbs'), irForRender),
      fileType: 'config',
      generatedBy: 'express/tsconfig.json.hbs',
      protected: false,
    })
    out.push({
      path: 'src/server.ts',
      content: render(tpl('server.ts.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'express/server.ts.hbs',
      protected: false,
    })
    out.push({
      path: 'src/router.ts',
      content: render(tpl('router.ts.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'express/router.ts.hbs',
      protected: true,
    })
    out.push({
      path: 'src/models.ts',
      content: render(tpl('models.ts.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'express/models.ts.hbs',
      protected: false,
    })
    out.push({
      path: 'src/service.ts',
      content: render(tpl('service.ts.hbs'), { ...irForRender, auditClassName }),
      fileType: 'source',
      generatedBy: 'express/service.ts.hbs',
      protected: false,
    })
    if (ir.audit?.enabled) {
      out.push({
        path: 'src/audit.ts',
        content: render(tpl('audit.ts.hbs'), { ...irForRender, auditClassName }),
        fileType: 'source',
        generatedBy: 'express/audit.ts.hbs',
        protected: true,
      })
    }
    out.push({
      path: 'src/service.test.ts',
      content: render(tpl('test-service.ts.hbs'), irForRender),
      fileType: 'test',
      generatedBy: 'express/test-service.ts.hbs',
      protected: false,
    })
    out.push({
      path: 'openapi.yml',
      content: render(tpl('openapi.yml.hbs'), irForRender),
      fileType: 'contract',
      generatedBy: 'express/openapi.yml.hbs',
      protected: false,
    })
    out.push({
      path: 'README.md',
      content: render(tpl('README.md.hbs'), irForRender),
      fileType: 'doc',
      generatedBy: 'express/README.md.hbs',
      protected: false,
    })
    return out
  },
}

export { TEMPLATE_VERSION as EXPRESS_TEMPLATE_VERSION }
