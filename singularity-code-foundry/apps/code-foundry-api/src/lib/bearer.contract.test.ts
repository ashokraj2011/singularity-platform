import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./bearer.ts', import.meta.url), 'utf8')
const configSource = readFileSync(new URL('../config.ts', import.meta.url), 'utf8')
const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const bareMetalSource = readFileSync(
  new URL('../../../../../bin/bare-metal.sh', import.meta.url),
  'utf8',
)
const composeSource = readFileSync(
  new URL('../../../../../docker-compose.yml', import.meta.url),
  'utf8',
)
const checkBody = source.slice(source.indexOf('return function check'))

assert.match(source, /function isProductionToken\(\): boolean/)
assert.match(source, /function isLocalhost\(req: Request\): boolean/)
assert.match(checkBody, /!isProductionToken\(\) && !isProductionClassEnv\(\) && isLocalhost\(req\)/)
assert.match(checkBody, /if \(typeof header !== 'string' \|\| !header\.startsWith\('Bearer '\)\)/)
assert.match(checkBody, /if \(token !== config\.CODEGEN_SERVICE_TOKEN\)/)
assert.doesNotMatch(checkBody, /if \(!isProductionToken\(\)\) \{[\s\S]*?return next\(\)[\s\S]*?\}/)
assert.doesNotMatch(source, /middleware accepts unauthenticated\s+requests/)
assert.match(configSource, /HOST: process\.env\.HOST \?\? '0\.0\.0\.0'/)
assert.match(serverSource, /app\.listen\(config\.PORT, config\.HOST/)
assert.match(bareMetalSource, /HOST=127\.0\.0\.1 PORT=3005/)
assert.match(composeSource, /127\.0\.0\.1:3005:3005/)

console.log('code-foundry bearer auth contract passed')
