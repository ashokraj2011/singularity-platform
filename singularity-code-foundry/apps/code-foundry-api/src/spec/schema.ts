/**
 * M42.1 — Service-spec Zod schema.
 *
 * Mirrors deterministic_code_layer_spec_v2.md §9 (greenfield `kind: service`)
 * with §9.3 security profile, §9.4 observability profile, and §9.5
 * resilience profile slots. M42.5 will add `kind: code_enhancement`
 * (§25.3) on top of the same lifecycle machinery — gated by a Zod
 * discriminated union on `kind`.
 *
 * Design rules followed in this file (do not relax without good reason):
 *   - Required fields are .strict() at the object level so unknown keys
 *     are rejected; this catches typos like `endpoint` (singular) before
 *     they silently disappear in IR build.
 *   - Cross-field invariants (path-param coverage, datasource-reference
 *     coverage) are NOT enforced here — they live in src/spec/validate.ts
 *     because Zod's superRefine produces less-readable error paths than
 *     hand-rolled checks for this kind of structural rule.
 */
import { z } from 'zod'

const stringId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'must be a lowerCamelCase identifier')

const dottedKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/, 'must match /^[a-zA-Z][a-zA-Z0-9._-]*$/')

const httpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const fieldType = z.enum([
  'string',
  'integer',
  'long',
  'number',
  'double',
  'boolean',
  'datetime',
  'date',
  'object',
  'array',
  'uuid',
])

const modelField = z
  .object({
    name: stringId,
    type: fieldType,
    required: z.boolean().optional().default(true),
    description: z.string().max(500).optional(),
    // For type=array; optional pointer to another model.
    items: z
      .object({
        type: fieldType.optional(),
        modelName: z.string().optional(),
      })
      .optional(),
    // For type=object; pointer to another model.
    modelName: z.string().optional(),
  })
  .strict()

const pathParam = z
  .object({
    name: stringId,
    type: fieldType,
    required: z.boolean().optional().default(true),
    description: z.string().max(500).optional(),
  })
  .strict()

const errorResponse = z
  .object({
    statusCode: z.number().int().min(100).max(599),
    type: z.string().min(1),
  })
  .strict()

const endpoint = z
  .object({
    name: stringId,
    operationId: stringId,
    method: httpMethod,
    path: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    auth: z.enum(['required', 'optional', 'none']).optional().default('required'),
    input: z
      .object({
        pathParams: z.array(pathParam).optional().default([]),
        queryParams: z.array(pathParam).optional().default([]),
        bodyType: z.string().optional(),
      })
      .strict()
      .optional(),
    output: z
      .object({
        statusCode: z.number().int().min(100).max(599).optional().default(200),
        type: z.string().min(1),
      })
      .strict(),
    errors: z.array(errorResponse).optional().default([]),
  })
  .strict()

const model = z
  .object({
    name: stringId,
    fields: z.array(modelField).min(1),
  })
  .strict()

const dataSource = z
  .object({
    name: stringId,
    type: z.enum(['rest', 'database', 'kafka', 'grpc']),
    clientName: z.string().optional(),
    baseUrlConfigKey: z.string().optional(),
    timeoutMs: z.number().int().min(1).max(60_000).optional(),
    requiredFields: z.array(z.string()).optional().default([]),
    resilience: z
      .object({
        runtime: z.enum(['resilience4j', 'opossum', 'tenacity']).optional(),
        retry: z
          .object({
            maxAttempts: z.number().int().min(1).max(10),
            waitDurationMs: z.number().int().min(1).max(60_000),
            retryOnExceptions: z.array(z.string()).optional().default([]),
          })
          .strict()
          .optional(),
        circuitBreaker: z
          .object({
            failureRateThreshold: z.number().min(0).max(100),
            slowCallDurationThresholdMs: z.number().int().min(1).optional(),
            slowCallRateThreshold: z.number().min(0).max(100).optional(),
            minimumNumberOfCalls: z.number().int().min(1).optional(),
            slidingWindowSize: z.number().int().min(1).optional(),
            waitDurationInOpenStateMs: z.number().int().min(1).optional(),
          })
          .strict()
          .optional(),
        bulkhead: z
          .object({ maxConcurrentCalls: z.number().int().min(1) })
          .strict()
          .optional(),
        fallback: z
          .object({
            strategy: z.enum(['cached_previous_response', 'static_default', 'empty']),
            ttlSeconds: z.number().int().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

// ─── Business logic DSL (§9.2) ────────────────────────────────────────────

const ruleWhen = z
  .object({
    field: z.string().min(1),
    operator: z.enum(['equals', 'notEquals', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte']),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
  })
  .strict()

const ruleOutcome = z.record(z.union([z.string(), z.number(), z.boolean()]))

const ruleDsl = z
  .object({
    id: stringId,
    description: z.string().max(500).optional(),
    inputs: z.array(z.string()).optional().default([]),
    output: z.string().min(1),
    logic: z
      .object({
        when: ruleWhen,
        then: ruleOutcome,
        else: ruleOutcome.optional(),
      })
      .strict(),
  })
  .strict()

const businessLogic = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('rule_reference'),
      rules: z.array(ruleDsl).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('external_rule_engine'),
      engine: z.enum(['dmn', 'drools', 'opa']),
      ruleSet: z.string().min(1),
      bindings: z.record(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal('llm_only'),
      // Spec explicitly leaves the body to the LLM. The IR builder marks
      // every endpoint NONE coverage and emits llm-editable regions.
      hint: z.string().max(2000).optional(),
    })
    .strict(),
])

// ─── Security profile (§9.3) ───────────────────────────────────────────────

const securityProfile = z
  .object({
    profile: z.enum([
      'oauth2-resource-server',
      'oauth2-client',
      'mtls-only',
      'internal-header',
      'none',
    ]),
    authn: z
      .object({
        type: z.enum(['oauth2', 'mtls', 'header']).optional(),
        issuer: z.string().optional(),
        audience: z.string().optional(),
        jwks: z.string().optional(),
      })
      .strict()
      .optional(),
    authz: z
      .object({
        rules: z
          .array(
            z
              .object({
                endpoint: z.string(),
                requiredScopes: z.array(z.string()).optional().default([]),
                requiredRoles: z.array(z.string()).optional().default([]),
              })
              .strict(),
          )
          .optional()
          .default([]),
      })
      .strict()
      .optional(),
    secrets: z
      .object({
        provider: z.enum(['vault', 'aws-sm', 'gcp-sm', 'env']).optional(),
        paths: z.array(z.string()).optional().default([]),
        forbidInEnv: z.boolean().optional().default(true),
      })
      .strict()
      .optional(),
    transport: z
      .object({
        inboundTls: z.enum(['required', 'optional', 'none']).optional(),
        outboundClients: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    policies: z
      .object({
        requireAuthOnAllEndpoints: z.boolean().optional().default(true),
        rejectInsecureHeaders: z.boolean().optional().default(true),
        rejectMixedContent: z.boolean().optional().default(true),
      })
      .strict()
      .optional(),
  })
  .strict()

// ─── Observability profile (§9.4) ──────────────────────────────────────────

const observabilityProfile = z
  .object({
    metrics: z
      .object({
        enabled: z.boolean().optional().default(true),
        runtime: z.enum(['micrometer', 'prometheus_client', 'otel']).optional(),
        registry: z.enum(['prometheus', 'otlp', 'none']).optional(),
        endpointSuffix: z.string().optional(),
        perEndpointTimers: z.boolean().optional().default(true),
        customMetrics: z
          .array(
            z
              .object({
                name: z.string().min(1),
                type: z.enum(['counter', 'gauge', 'histogram', 'timer']),
                labels: z.array(z.string()).optional().default([]),
              })
              .strict(),
          )
          .optional()
          .default([]),
      })
      .strict()
      .optional(),
    tracing: z
      .object({
        enabled: z.boolean().optional().default(true),
        runtime: z.enum(['opentelemetry']).optional(),
        exporter: z.enum(['otlp', 'jaeger', 'zipkin']).optional(),
        sampling: z
          .object({
            type: z.string(),
            ratio: z.number().min(0).max(1).optional(),
          })
          .strict()
          .optional(),
        propagation: z.array(z.enum(['w3c', 'b3', 'jaeger'])).optional().default(['w3c']),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        runtime: z.enum(['logback', 'logging', 'pino', 'winston']).optional(),
        format: z.enum(['json', 'text']).optional().default('json'),
        correlationIdHeader: z.string().optional().default('X-Correlation-Id'),
        fields: z.array(z.string()).optional().default([]),
        redact: z.array(z.string()).optional().default([]),
      })
      .strict()
      .optional(),
    health: z
      .object({
        livenessPath: z.string().optional().default('/actuator/health/liveness'),
        readinessPath: z.string().optional().default('/actuator/health/readiness'),
        includeDownstreamChecks: z.array(z.string()).optional().default([]),
      })
      .strict()
      .optional(),
  })
  .strict()

// ─── LLM allowance (§9.1 bottom) ───────────────────────────────────────────

const llmAllowance = z
  .object({
    allowed: z.boolean().optional().default(true),
    allowedTasks: z
      .array(
        z.enum([
          'COMPLETE_METHOD_BODY',
          'GENERATE_ADDITIONAL_TESTS',
          'FIX_COMPILE_ERROR',
          'COMPLETE_MAPPING_LOGIC',
          'UPDATE_TEST_ASSERTIONS',
        ]),
      )
      .optional()
      .default(['COMPLETE_METHOD_BODY', 'FIX_COMPILE_ERROR']),
    forbiddenChanges: z
      .array(
        z.enum([
          'API_CONTRACT',
          'PACKAGE_NAME',
          'SECURITY_CONFIG',
          'AUDIT_CONTRACT',
          'API_PATH',
          'HTTP_METHOD',
          'EXISTING_PUBLIC_CONTRACTS_UNLESS_DECLARED',
        ]),
      )
      .optional()
      .default(['API_CONTRACT', 'PACKAGE_NAME', 'SECURITY_CONFIG', 'AUDIT_CONTRACT']),
  })
  .strict()

// ─── Top-level service spec ────────────────────────────────────────────────

const application = z
  .object({
    name: stringId,
    groupId: dottedKey,
    artifactId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    packageName: dottedKey,
    language: z.enum(['java', 'python', 'typescript']),
    framework: z.enum(['spring-boot', 'fastapi', 'express']),
    buildTool: z.enum(['maven', 'gradle', 'poetry', 'pip', 'npm']),
    javaVersion: z.string().optional(),
    pythonVersion: z.string().optional(),
    nodeVersion: z.string().optional(),
  })
  .strict()

export const serviceSpecSchema = z
  .object({
    specVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    kind: z.literal('service'),
    metadata: z
      .object({
        id: z.string().min(1).max(120),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        ownerTeam: z.string().optional(),
        capability: z.string().optional(),
        version: z.string().optional().default('1.0.0'),
      })
      .strict(),
    application,
    api: z
      .object({
        basePath: z.string().min(1).max(200),
        endpoints: z.array(endpoint).min(1),
      })
      .strict(),
    models: z.array(model).optional().default([]),
    dataSources: z.array(dataSource).optional().default([]),
    businessLogic: businessLogic.optional(),
    audit: z
      .object({
        enabled: z.boolean(),
        eventName: z.string().min(1).optional(),
        fields: z.array(z.string()).optional().default([]),
      })
      .strict()
      .optional(),
    tests: z
      .object({
        generateUnitTests: z.boolean().optional().default(true),
        generateContractTests: z.boolean().optional().default(false),
        cases: z
          .array(
            z
              .object({
                name: z.string(),
                input: z.record(z.unknown()),
                expected: z.record(z.unknown()),
              })
              .strict(),
          )
          .optional()
          .default([]),
      })
      .strict()
      .optional(),
    security: securityProfile.optional(),
    observability: observabilityProfile.optional(),
    llm: llmAllowance.optional(),
  })
  .strict()

export type ServiceSpec = z.infer<typeof serviceSpecSchema>
