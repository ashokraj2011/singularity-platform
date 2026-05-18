import { writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const STACK_TEMPLATES: Record<string, string> = {
  spring: `specVersion: 1.0.0
kind: service

metadata:
  id: eligibility-service-spec
  name: Eligibility Service
  description: Customer eligibility evaluation service.
  ownerTeam: Personalization Platform
  capability: Personalization

application:
  name: EligibilityService
  groupId: com.company.personalization
  artifactId: eligibility-service
  packageName: com.company.personalization.eligibility
  language: java
  framework: spring-boot
  buildTool: maven
  javaVersion: "21"

api:
  basePath: /customers
  endpoints:
    - name: GetCustomerEligibility
      operationId: getCustomerEligibility
      method: GET
      path: /{customerId}/eligibility
      auth: required
      input:
        pathParams:
          - name: customerId
            type: string
            required: true
      output:
        statusCode: 200
        type: EligibilityResponse
      errors:
        - { statusCode: 400, type: ErrorResponse }
        - { statusCode: 404, type: ErrorResponse }
        - { statusCode: 500, type: ErrorResponse }

models:
  - name: EligibilityResponse
    fields:
      - { name: eligible,     type: boolean,  required: true }
      - { name: reason,       type: string,   required: true }
      - { name: evaluatedAt,  type: datetime, required: true }
  - name: ErrorResponse
    fields:
      - { name: code,    type: string, required: true }
      - { name: message, type: string, required: true }
      - { name: traceId, type: string, required: false }

dataSources:
  - name: customerProfileApi
    type: rest
    clientName: CustomerProfileClient
    baseUrlConfigKey: customer.profile.baseUrl
    timeoutMs: 500
    requiredFields: [customerId, beneficiaryStatus]
    resilience:
      runtime: resilience4j
      retry: { maxAttempts: 3, waitDurationMs: 100 }
      circuitBreaker: { failureRateThreshold: 50 }
      bulkhead: { maxConcurrentCalls: 25 }
      fallback: { strategy: cached_previous_response, ttlSeconds: 60 }

businessLogic:
  type: rule_reference
  rules:
    - id: getCustomerEligibility
      description: Customer is eligible only if beneficiary status is missing.
      inputs: [customerProfileApi.beneficiaryStatus]
      output: EligibilityResponse
      logic:
        when: { field: beneficiaryStatus, operator: equals, value: MISSING }
        then: { eligible: true,  reason: BENEFICIARY_MISSING }
        else: { eligible: false, reason: NOT_ELIGIBLE }

audit:
  enabled: true
  eventName: CUSTOMER_ELIGIBILITY_EVALUATED
  fields: [customerId, eligible, reason]

tests:
  generateUnitTests: true
  generateContractTests: true
  cases:
    - name: beneficiary missing returns eligible
      input:    { customerId: "123", beneficiaryStatus: MISSING }
      expected: { eligible: true,  reason: BENEFICIARY_MISSING }
    - name: beneficiary present returns not eligible
      input:    { customerId: "456", beneficiaryStatus: PRESENT }
      expected: { eligible: false, reason: NOT_ELIGIBLE }
`,
  fastapi: `specVersion: 1.0.0
kind: service

metadata:
  id: eligibility-service-fastapi-spec
  name: Eligibility Service (FastAPI)
  description: Python/FastAPI variant of the eligibility service.
  ownerTeam: Personalization Platform
  capability: Personalization

application:
  name: EligibilityService
  groupId: com.company.personalization
  artifactId: eligibility-service
  packageName: com.company.personalization.eligibility
  language: python
  framework: fastapi
  buildTool: poetry
  pythonVersion: "3.11"

api:
  basePath: /customers
  endpoints:
    - name: GetCustomerEligibility
      operationId: getCustomerEligibility
      method: GET
      path: /{customerId}/eligibility
      auth: required
      input:
        pathParams:
          - { name: customerId, type: string, required: true }
      output: { statusCode: 200, type: EligibilityResponse }
      errors:
        - { statusCode: 400, type: ErrorResponse }
        - { statusCode: 404, type: ErrorResponse }

models:
  - name: EligibilityResponse
    fields:
      - { name: eligible,    type: boolean,  required: true }
      - { name: reason,      type: string,   required: true }
      - { name: evaluatedAt, type: datetime, required: true }
  - name: ErrorResponse
    fields:
      - { name: code,    type: string, required: true }
      - { name: message, type: string, required: true }

dataSources:
  - name: customerProfileApi
    type: rest
    timeoutMs: 500
    resilience:
      runtime: tenacity
      retry: { maxAttempts: 3, waitDurationMs: 100 }
      circuitBreaker: { failureRateThreshold: 50 }
      fallback: { strategy: cached_previous_response, ttlSeconds: 60 }

audit:
  enabled: true
  eventName: CUSTOMER_ELIGIBILITY_EVALUATED
`,
  express: `specVersion: 1.0.0
kind: service

metadata:
  id: eligibility-service-express-spec
  name: Eligibility Service (Express)
  description: TypeScript/Express variant.
  capability: Personalization

application:
  name: EligibilityService
  groupId: com.company.personalization
  artifactId: eligibility-service
  packageName: com.company.personalization.eligibility
  language: typescript
  framework: express
  buildTool: npm
  nodeVersion: "20"

api:
  basePath: /customers
  endpoints:
    - name: GetCustomerEligibility
      operationId: getCustomerEligibility
      method: GET
      path: /{customerId}/eligibility
      auth: required
      input:
        pathParams:
          - { name: customerId, type: string, required: true }
      output: { statusCode: 200, type: EligibilityResponse }
      errors:
        - { statusCode: 400, type: ErrorResponse }
        - { statusCode: 404, type: ErrorResponse }

models:
  - name: EligibilityResponse
    fields:
      - { name: eligible,    type: boolean,  required: true }
      - { name: reason,      type: string,   required: true }
      - { name: evaluatedAt, type: datetime, required: true }
  - name: ErrorResponse
    fields:
      - { name: code,    type: string, required: true }
      - { name: message, type: string, required: true }

dataSources:
  - name: customerProfileApi
    type: rest
    timeoutMs: 500
    resilience:
      runtime: opossum
      retry: { maxAttempts: 3, waitDurationMs: 100 }
      circuitBreaker: { failureRateThreshold: 50 }
      fallback: { strategy: cached_previous_response, ttlSeconds: 60 }

audit:
  enabled: true
  eventName: CUSTOMER_ELIGIBILITY_EVALUATED
`,
}

export async function initCommand(opts: { kind: string; stack: string; out: string }): Promise<void> {
  if (opts.kind !== 'service') {
    throw Object.assign(new Error('Only --kind=service is supported in M42.1'), { exitCode: 2 })
  }
  const tpl = STACK_TEMPLATES[opts.stack]
  if (!tpl) {
    throw Object.assign(new Error(`Unknown --stack '${opts.stack}'. Choose one of: ${Object.keys(STACK_TEMPLATES).join(', ')}`), { exitCode: 2 })
  }
  const path = resolve(process.cwd(), opts.out)
  if (existsSync(path)) {
    throw Object.assign(new Error(`Refusing to overwrite ${path}`), { exitCode: 2 })
  }
  writeFileSync(path, tpl, 'utf8')
  process.stdout.write(`Wrote ${path}\n`)
}
