#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'contracts', 'kap')
const DOCS = ['openapi.json', 'asyncapi.json']
const check = process.argv.includes('--check')

/* 字段名照拄 kimi 实例注册表，不改成驼峰。 */
type Instance = { host: string; port: number; pid: number; started_at: number }

const codeOf = (value: unknown): string | undefined => {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code

    if (typeof code === 'string') {
      return code
    }
  }

  return undefined
}

const reason = (error: unknown): string => {
  if (error instanceof Error) {
    return codeOf(error.cause) ?? error.message
  }

  return String(error)
}

const die = (message: string): never => {
  process.stderr.write(['kap spec-sync: ', message, '\n'].join(''))
  process.exit(1)
}

const isInstance = (value: unknown): value is Instance => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate['host'] === 'string' &&
    typeof candidate['port'] === 'number' &&
    typeof candidate['pid'] === 'number' &&
    typeof candidate['started_at'] === 'number'
  )
}

/* ESRCH 表示进程已消失，EPERM 表示活着但属于其他用户。 */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return codeOf(error) !== 'ESRCH'
  }
}

/* 通配绑定在注册表里记的是 0.0.0.0 / ::，这两个地址不是每个平台都能拨号。 */
const dialableHost = (host: string): string => {
  if (host === '0.0.0.0' || host === '::' || host === '') {
    return '127.0.0.1'
  }

  return host.includes(':') ? ['[', host, ']'].join('') : host
}

const home = (): string => process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code')

const readToken = (): string => {
  const tokenPath = join(home(), 'server.token')

  if (!existsSync(tokenPath)) {
    die(['no server token at ', tokenPath, '; run "kimi web --no-open" once'].join(''))
  }

  return readFileSync(tokenPath, 'utf8').trim()
}

const readOrigin = (): string => {
  const configured = process.env['KAP_ORIGIN']

  if (configured !== undefined) {
    return configured
  }

  const dir = join(home(), 'server', 'instances')

  if (!existsSync(dir)) {
    die(['no instance registry at ', dir, '; run "kimi web --no-open" first'].join(''))
  }

  const live = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name): unknown => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        return undefined
      }
    })
    .filter(isInstance)
    .filter((entry) => pidAlive(entry.pid))
    .sort((a, b) => a.started_at - b.started_at)

  const first = live[0]

  if (first === undefined) {
    return die('no live kap instance; run "kimi web --no-open" first')
  }

  return ['http://', dialableHost(first.host), ':', String(first.port)].join('')
}

/* 路径拼接交给 WHATWG URL，不手搬斜杠。 */
const download = async (origin: string, token: string, name: string): Promise<string> => {
  let response: Response

  try {
    response = await fetch(new URL(name, origin), {
      headers: { Authorization: ['Bearer ', token].join('') },
    })
  } catch (error) {
    return die(['cannot reach ', origin, ': ', reason(error)].join(''))
  }

  if (!response.ok) {
    die(['GET /', name, ' -> ', String(response.status)].join(''))
  }

  return [JSON.stringify(await response.json(), null, 2), '\n'].join('')
}

async function main(): Promise<void> {
  const token = readToken()
  const origin = readOrigin()

  mkdirSync(OUT, { recursive: true })

  let drifted = false

  for (const name of DOCS) {
    const next = await download(origin, token, name)
    const target = join(OUT, name)
    const previous = existsSync(target) ? readFileSync(target, 'utf8') : ''

    if (previous === next) {
      continue
    }

    if (check) {
      process.stderr.write(
        ['kap spec-sync: ', name, ' drifted from the pinned snapshot\n'].join(''),
      )
      drifted = true
      continue
    }

    writeFileSync(target, next, 'utf8')
    process.stdout.write(['updated contracts/kap/', name, '\n'].join(''))
  }

  if (drifted) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  process.stderr.write([reason(error), '\n'].join(''))
  process.exitCode = 1
})
