const { spawn } = require('node:child_process')
const http = require('node:http')
const electron = require('electron')

const rendererUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5177'

function bin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function waitForUrl(url, timeoutMs = 30_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, res => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`))
        } else {
          setTimeout(check, 350)
        }
      })
      req.setTimeout(1_000, () => req.destroy())
    }
    check()
  })
}

const vite = spawn(bin('pnpm'), ['exec', 'vite', '--host', '0.0.0.0', '--port', '5177', '--strictPort'], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
})

let electronProcess

function shutdown(code = 0) {
  if (electronProcess && !electronProcess.killed) electronProcess.kill()
  if (!vite.killed) vite.kill()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

vite.on('exit', code => {
  if (!electronProcess) shutdown(code ?? 1)
})

waitForUrl(rendererUrl)
  .then(() => {
    electronProcess = spawn(electron, ['.'], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, VITE_DEV_SERVER_URL: rendererUrl },
    })
    electronProcess.on('exit', code => shutdown(code ?? 0))
  })
  .catch(err => {
    console.error(err.message)
    shutdown(1)
  })
