#!/usr/bin/env node
// Export kap's generated contracts from a running "kimi web" and pin them.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'contracts', 'kap')
const DOCS = ['openapi.json', 'asyncapi.json']
const check = process.argv.includes('--check')

const die = (msg) => {
  process.stderr.write(`kap spec-sync: ${msg}\n`)
  process.exit(1)
}

const home = process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')

const readToken = () => {
  const path = join(home, 'server.token')
  if (!existsSync(path)) {
    die(`no server token at ${path}; run "kimi web --no-open" once`)
  }
  return readFileSync(path, 'utf8').trim()
}

// Mirrors kimi's own registry sweep: ESRCH means gone, EPERM means alive but
// owned by another user. A crashed server leaves its instance file behind.
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

// A wildcard bind records 0.0.0.0 / :: in the registry; neither dials on every
// platform, so reach the same listener over loopback instead.
const dialableHost = (host) => {
  if (host === '0.0.0.0' || host === '::' || host === '') {
    return '127.0.0.1'
  }
  return host.includes(':') ? `[${host}]` : host
}

const readOrigin = () => {
  if (process.env.KAP_ORIGIN !== undefined) {
    return process.env.KAP_ORIGIN
  }
  const dir = join(home, 'server', 'instances')
  if (!existsSync(dir)) {
    die(`no instance registry at ${dir}; run "kimi web --no-open" first`)
  }
  const live = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        return undefined
      }
    })
    .filter((entry) => entry !== undefined && typeof entry.port === 'number')
    .filter((entry) => typeof entry.pid === 'number' && pidAlive(entry.pid))
    .sort((a, b) => a.started_at - b.started_at)
  if (live.length === 0) {
    die('no live kap instance; run "kimi web --no-open" first')
  }
  return `http://${dialableHost(live[0].host)}:${live[0].port}`
}

const token = readToken()
const origin = readOrigin()

mkdirSync(OUT, { recursive: true })
let drifted = false

for (const name of DOCS) {
  let res
  try {
    res = await fetch(`${origin}/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (error) {
    die(`cannot reach ${origin}: ${error.cause?.code ?? error.message}`)
  }
  if (!res.ok) {
    die(`GET /${name} -> ${res.status}`)
  }
  const next = `${JSON.stringify(await res.json(), null, 2)}\n`
  const path = join(OUT, name)
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (prev === next) {
    continue
  }
  if (check) {
    process.stderr.write(`kap spec-sync: ${name} drifted from the pinned snapshot\n`)
    drifted = true
    continue
  }
  writeFileSync(path, next, 'utf8')
  process.stdout.write(`updated contracts/kap/${name}\n`)
}

if (drifted) {
  process.exit(1)
}
