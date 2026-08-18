#!/usr/bin/env node
// Export kap's generated contracts from a running `kimi web` and pin them.
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

const token = (() => {
  const p = join(home, 'server.token')
  if (!existsSync(p)) die(`no server token at ${p}; start \`kimi web --no-open\` once`)
  return readFileSync(p, 'utf8').trim()
})()

const origin = (() => {
  if (process.env.KAP_ORIGIN !== undefined) return process.env.KAP_ORIGIN
  const dir = join(home, 'server', 'instances')
  if (!existsSync(dir)) die(`no instance registry at ${dir}; is \`kimi web\` running?`)
  const live = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      try {
        return JSON.parse(readFileSync(join(dir, n), 'utf8'))
      } catch {
        return undefined
      }
    })
    .filter((e) => e !== undefined && typeof e.port === 'number')
    .sort((a, b) => a.started_at - b.started_at)
  if (live.length === 0) die('no live kap instance registered')
  return `http://${live[0].host}:${live[0].port}`
})()

mkdirSync(OUT, { recursive: true })
let drifted = false

for (const name of DOCS) {
  const res = await fetch(`${origin}/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) die(`GET /${name} -> ${res.status}`)
  const next = `${JSON.stringify(await res.json(), null, 2)}\n`
  const path = join(OUT, name)
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (prev === next) continue
  if (check) {
    process.stderr.write(`kap spec-sync: ${name} drifted from the pinned snapshot\n`)
    drifted = true
    continue
  }
  writeFileSync(path, next, 'utf8')
  process.stdout.write(`updated contracts/kap/${name}\n`)
}

if (drifted) process.exit(1)
