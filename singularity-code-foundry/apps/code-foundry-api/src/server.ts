import { createApp } from './app.js'
import { config } from './config.js'
import { log } from './lib/log.js'

const app = createApp()
app.listen(config.PORT, () => {
  log.info(`code-foundry-api listening on :${config.PORT}`)
})
