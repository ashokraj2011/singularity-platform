/**
 * M42.2 — Spring Boot generator.
 *
 * Selected when ir.application.framework === 'spring-boot'. Emits the
 * deterministic baseline from spec §10/§11: pom, application class,
 * controller, DTOs, service interface + impl, audit logger, exception
 * handler, application.yml, openapi.yml, README, one controller test,
 * plus generation-manifest.json (written separately by the writer).
 *
 * The IR carries all per-stack naming + type info, so templates stay
 * stack-naïve except for syntax.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ApplicationIr } from '../../ir/types.js'
import { render } from '../templateEngine.js'
import type { CodeGenerator, GeneratedFile } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, '../../templates/springboot')
const TEMPLATE_VERSION = 'springboot-template-0.1.0'

function tpl(name: string): string {
  return readFileSync(join(TEMPLATES_DIR, name), 'utf8')
}

function packagePath(pkg: string): string {
  return pkg.replace(/\./g, '/')
}

function fieldTypeFlags(ir: ApplicationIr): { hasDateTime: boolean; hasUuid: boolean } {
  let hasDateTime = false
  let hasUuid = false
  for (const m of ir.models) {
    for (const f of m.fields) {
      if (f.javaType === 'OffsetDateTime' || f.javaType === 'LocalDate') hasDateTime = true
      if (f.javaType === 'UUID') hasUuid = true
    }
  }
  return { hasDateTime, hasUuid }
}

export const springbootGenerator: CodeGenerator = {
  id: 'springboot',
  supports(ir) {
    return ir.application.framework === 'spring-boot'
  },
  generate(ir): GeneratedFile[] {
    // Re-stamp the IR meta with this generator's template version so
    // every header / receipt carries the same value.
    const stampedMeta = { ...ir.meta, templateVersion: TEMPLATE_VERSION }
    const irForRender: ApplicationIr = { ...ir, meta: stampedMeta }

    const out: GeneratedFile[] = []
    const pkgPath = packagePath(ir.application.packageName)
    const srcMain = `src/main/java/${pkgPath}`
    const srcTest = `src/test/java/${pkgPath}`

    const auditClassName = `${ir.application.name.replace(/Service$/, '')}AuditLogger`

    const hasResilience = ir.dataSources.some(ds => ds.hasResilience)

    // pom.xml
    out.push({
      path: 'pom.xml',
      content: render(tpl('pom.xml.hbs'), { ...irForRender, hasResilience }),
      fileType: 'config',
      generatedBy: 'springboot/pom.xml.hbs',
      protected: false,
    })

    // Application class
    out.push({
      path: `${srcMain}/${ir.application.name}Application.java`,
      content: render(tpl('application.java.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'springboot/application.java.hbs',
      protected: false,
    })

    // Controller (one per endpoint — M42.2 only models one controller
    // for the canonical single-endpoint examples; multi-endpoint
    // grouping lands in M42.3 alongside the verifier).
    for (const ep of ir.endpoints) {
      out.push({
        path: `${srcMain}/controller/${ep.controllerName}.java`,
        content: render(tpl('controller.java.hbs'), { ...irForRender, endpoint: ep }),
        fileType: 'source',
        generatedBy: 'springboot/controller.java.hbs',
        protected: true,
      })
    }

    // DTOs
    const flags = fieldTypeFlags(ir)
    for (const model of ir.models) {
      out.push({
        path: `${srcMain}/model/${model.name}.java`,
        content: render(tpl('dto.java.hbs'), { ...irForRender, model, ...flags }),
        fileType: 'source',
        generatedBy: 'springboot/dto.java.hbs',
        protected: false,
      })
    }

    // Service interface + impl (one per endpoint, named for the operation
    // for clarity in this single-endpoint example shape).
    for (const ep of ir.endpoints) {
      out.push({
        path: `${srcMain}/service/${ep.serviceName}.java`,
        content: render(tpl('service-interface.java.hbs'), { ...irForRender, endpoint: ep }),
        fileType: 'source',
        generatedBy: 'springboot/service-interface.java.hbs',
        protected: false,
      })
      out.push({
        path: `${srcMain}/service/${ep.serviceName}Impl.java`,
        content: render(tpl('service-impl.java.hbs'), {
          ...irForRender,
          endpoint: ep,
          auditClassName,
        }),
        fileType: 'source',
        generatedBy: 'springboot/service-impl.java.hbs',
        protected: false, // contains an llm-editable region for PARTIAL/NONE coverage
      })
    }

    // Audit logger (only when audit is enabled)
    if (ir.audit?.enabled) {
      out.push({
        path: `${srcMain}/audit/${auditClassName}.java`,
        content: render(tpl('audit-logger.java.hbs'), { ...irForRender, auditClassName }),
        fileType: 'source',
        generatedBy: 'springboot/audit-logger.java.hbs',
        protected: true,
      })
    }

    // Global exception handler
    out.push({
      path: `${srcMain}/exception/GlobalExceptionHandler.java`,
      content: render(tpl('exception-handler.java.hbs'), irForRender),
      fileType: 'source',
      generatedBy: 'springboot/exception-handler.java.hbs',
      protected: true,
    })

    // Resources
    out.push({
      path: 'src/main/resources/application.yml',
      content: render(tpl('application.yml.hbs'), irForRender),
      fileType: 'config',
      generatedBy: 'springboot/application.yml.hbs',
      protected: false,
    })
    out.push({
      path: 'src/main/resources/openapi.yml',
      content: render(tpl('openapi.yml.hbs'), irForRender),
      fileType: 'contract',
      generatedBy: 'springboot/openapi.yml.hbs',
      protected: false,
    })

    // One controller test placeholder per endpoint
    for (const ep of ir.endpoints) {
      out.push({
        path: `${srcTest}/controller/${ep.controllerName}Test.java`,
        content: render(tpl('test-controller.java.hbs'), { ...irForRender, endpoint: ep }),
        fileType: 'test',
        generatedBy: 'springboot/test-controller.java.hbs',
        protected: false,
      })
    }

    // README
    out.push({
      path: 'README.md',
      content: render(tpl('README.md.hbs'), irForRender),
      fileType: 'doc',
      generatedBy: 'springboot/README.md.hbs',
      protected: false,
    })

    return out
  },
}

export { TEMPLATE_VERSION as SPRINGBOOT_TEMPLATE_VERSION }
