/**
 * M42.2 — FastAPI generator (Python 3.11 + pydantic v2 + httpx).
 *
 * Mirror of the Spring Boot generator but emits Python. Same IR input,
 * same coverage-driven body rule, same typed region markers.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ApplicationIr } from '../../ir/types.js'
import { render } from '../templateEngine.js'
import type { CodeGenerator, GeneratedFile } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, '../../templates/fastapi')
const TEMPLATE_VERSION = 'fastapi-template-0.1.0'

function tpl(name: string): string {
  return readFileSync(join(TEMPLATES_DIR, name), 'utf8')
}

export const fastapiGenerator: CodeGenerator = {
  id: 'fastapi',
  supports(ir) {
    return ir.application.framework === 'fastapi'
  },
  generate(ir): GeneratedFile[] {
    const stampedMeta = { ...ir.meta, templateVersion: TEMPLATE_VERSION }
    const irForRender: ApplicationIr = { ...ir, meta: stampedMeta }
    const hasResilience = ir.dataSources.some(ds => ds.hasResilience)
    const auditClassName = `${ir.application.name.replace(/Service$/, '')}AuditLogger`

    const out: GeneratedFile[] = []

    out.push({
      path: 'pyproject.toml',
      content: render(tpl('pyproject.toml.hbs'), { ...irForRender, hasResilience }),
      fileType: 'config',
      generatedBy: 'fastapi/pyproject.toml.hbs',
      protected: false,
    })
    out.push({
      path: 'app/__init__.py',
      content: '',
      fileType: 'source',
      generatedBy: 'fastapi/__init__',
      protected: false,
    })
    out.push({
      path: 'app/main.py',
      content: render(tpl('main.py.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'fastapi/main.py.hbs',
      protected: false,
    })
    out.push({
      path: 'app/router.py',
      content: render(tpl('router.py.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'fastapi/router.py.hbs',
      protected: true,
    })
    out.push({
      path: 'app/models.py',
      content: render(tpl('models.py.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'fastapi/models.py.hbs',
      protected: false,
    })
    out.push({
      path: 'app/service.py',
      content: render(tpl('service.py.hbs'), { ...irForRender, auditClassName }),
      fileType: 'source',
      generatedBy: 'fastapi/service.py.hbs',
      protected: false,
    })
    if (ir.audit?.enabled) {
      out.push({
        path: 'app/audit.py',
        content: render(tpl('audit.py.hbs'), { ...irForRender, auditClassName }),
        fileType: 'source',
        generatedBy: 'fastapi/audit.py.hbs',
        protected: true,
      })
    }
    out.push({
      path: 'tests/__init__.py',
      content: '',
      fileType: 'test',
      generatedBy: 'fastapi/__init__',
      protected: false,
    })
    out.push({
      path: 'tests/test_service.py',
      content: render(tpl('test_service.py.hbs'), irForRender),
      fileType: 'test',
      generatedBy: 'fastapi/test_service.py.hbs',
      protected: false,
    })
    out.push({
      path: 'openapi.yml',
      content: render(tpl('openapi.yml.hbs'), irForRender),
      fileType: 'contract',
      generatedBy: 'fastapi/openapi.yml.hbs',
      protected: false,
    })
    out.push({
      path: 'README.md',
      content: render(tpl('README.md.hbs'), irForRender),
      fileType: 'doc',
      generatedBy: 'fastapi/README.md.hbs',
      protected: false,
    })

    return out
  },
}

export { TEMPLATE_VERSION as FASTAPI_TEMPLATE_VERSION }
