/**
 * M11 follow-up — OpenTelemetry auto-instrumentation bootstrap.
 *
 * Must be imported BEFORE any other module that we want auto-instrumented
 * (express, prisma, http, fetch, pg). The pattern is:
 *
 *   // src/index.ts FIRST line:
 *   import './lib/observability/otel'
 *   // ...everything else
 *
 * Configuration via env (defaults shown):
 *   OTEL_SERVICE_NAME            "workgraph-api"
 *   OTEL_EXPORTER_OTLP_ENDPOINT  "http://host.docker.internal:4318"
 *   OTEL_DISABLED                "" (set to "1" to no-op)
 *   OTEL_LOG_LEVEL               "" (set to "debug" for verbose SDK logs)
 */

if (!process.env.OTEL_DISABLED) {
  // Lazy require so the import has zero cost when disabled.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NodeSDK }                = require('@opentelemetry/sdk-node')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OTLPTraceExporter }      = require('@opentelemetry/exporter-trace-otlp-http')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resourceFromAttributes } = require('@opentelemetry/resources')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions')

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://host.docker.internal:4318'
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]:    process.env.OTEL_SERVICE_NAME ?? 'workgraph-api',
      [ATTR_SERVICE_VERSION]: '0.1.0',
      'service.namespace':    'singularity',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Trim noisy fs spans; everything else (http, express, pg, prisma,
        // dns, net) stays on by default.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  })

  try {
    sdk.start()
    // eslint-disable-next-line no-console
    console.log(`[otel] tracer started → ${endpoint}/v1/traces`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[otel] failed to start:', (err as Error).message)
  }

  process.on('SIGTERM', () => { void sdk.shutdown() })
  process.on('SIGINT',  () => { void sdk.shutdown() })
}
