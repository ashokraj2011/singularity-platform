import { createApp } from './app.js'
import { config } from './config.js'
import { log } from './lib/log.js'

const app = createApp()
app.listen(config.PORT, config.HOST, () => {
  log.info(`code-foundry-api listening on ${config.HOST}:${config.PORT}`)
})
