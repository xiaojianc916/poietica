#!/usr/bin/env bun
/**
 * kap 契约快照的同步与校验（bun run kap:spec / kap:spec:check）。
 *
 * 契约由 server 自述（GET /openapi.json、/asyncapi.json），本脚本把两份快照钉进
 * contracts/kap，并从同一份快照文本派生两份校验物：capabilities.json（能力集
 * 矩阵，升级审 diff 的那一页）与 checksums.json（快照指纹，守快照只经本脚本
 * 改动）。派生物没有第二个事实来源：都从快照文本计算，重算即比对。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'contracts', 'kap')
const DOCS = ['openapi.json', 'asyncapi.json']
const check = process.argv.includes('--check')

/* 字段名照抄 kimi 实例注册表，不改成驼峰。 */
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

// ── 派生物：从快照文本计算，没有第二个来源 ─────────────────────────────────

/** 沿键链取值；任何一格缺席都按「快照形状变了」失败，不静默降级。 */
const pick = (root: unknown, keys: readonly string[], where: string): unknown => {
  let node: unknown = root

  for (const key of keys) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new Error(`contracts/kap: ${where} 里 ${key} 之前不是对象；快照形状变了，先修派生`)
    }

    const next = (node as Record<string, unknown>)[key]

    if (next === undefined) {
      throw new Error(`contracts/kap: ${where} 缺 ${key}；快照形状变了，先修派生`)
    }

    node = next
  }

  return node
}

const keysOf = (node: unknown, where: string): string[] => {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new Error(`contracts/kap: ${where} 不是对象；快照形状变了，先修派生`)
  }

  return Object.keys(node).sort()
}

/**
 * 能力集矩阵：REST /meta 与 WS server_hello 各自声明的能力名，钉在快照的
 * server_version 上。升级 kimi-code 后审这一页，比审两千行 JSON diff 快。
 */
export function capabilitiesText(openapiText: string, asyncapiText: string): string {
  const openapi: unknown = JSON.parse(openapiText)
  const asyncapi: unknown = JSON.parse(asyncapiText)

  const version = pick(openapi, ['info', 'version'], 'openapi info')
  const eventVersion = pick(asyncapi, ['info', 'version'], 'asyncapi info')

  if (version !== eventVersion) {
    throw new Error(
      `contracts/kap: 两份快照的 info.version 不一致（${String(version)} vs ${String(eventVersion)}）`,
    )
  }

  const matrix = {
    hello_capabilities: keysOf(
      pick(
        asyncapi,
        [
          'components',
          'messages',
          'server_hello',
          'payload',
          'properties',
          'payload',
          'properties',
          'capabilities',
          'properties',
        ],
        'asyncapi server_hello',
      ),
      'asyncapi server_hello capabilities',
    ),
    meta_capabilities: keysOf(
      pick(
        openapi,
        [
          'paths',
          '/api/v1/meta',
          'get',
          'responses',
          '200',
          'content',
          'application/json',
          'schema',
          'properties',
          'data',
          'properties',
          'capabilities',
          'properties',
        ],
        'openapi /api/v1/meta',
      ),
      'openapi /api/v1/meta capabilities',
    ),
    server_version: version,
  }

  return `${JSON.stringify(matrix, null, 2)}\n`
}

/** 快照指纹：两份快照全文的 sha256。守的是「快照只经 kap:spec 改动」。 */
export function checksumsText(openapiText: string, asyncapiText: string): string {
  const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

  return `${JSON.stringify(
    { 'asyncapi.json': sha256(asyncapiText), 'openapi.json': sha256(openapiText) },
    null,
    2,
  )}\n`
}

const derivedFiles = (openapiText: string, asyncapiText: string): Array<[string, string]> => [
  ['capabilities.json', capabilitiesText(openapiText, asyncapiText)],
  ['checksums.json', checksumsText(openapiText, asyncapiText)],
]

const readSnapshot = (name: string): string => {
  const target = join(OUT, name)

  if (!existsSync(target)) {
    die(['no pinned snapshot at ', target, '; run "bun run kap:spec" first'].join(''))
  }

  return readFileSync(target, 'utf8')
}

/** 离线核对派生物与磁盘快照一致：手改快照、或刷新后忘了连带派生，在这里红。 */
function verifyDerived(): boolean {
  const openapiText = readSnapshot('openapi.json')
  const asyncapiText = readSnapshot('asyncapi.json')

  let drifted = false

  for (const [name, expected] of derivedFiles(openapiText, asyncapiText)) {
    const target = join(OUT, name)
    const previous = existsSync(target) ? readFileSync(target, 'utf8') : ''

    if (previous === expected) {
      continue
    }

    process.stderr.write(`kap spec-sync: ${name} does not match the pinned snapshots\n`)
    drifted = true
  }

  return drifted
}

function writeDerived(openapiText: string, asyncapiText: string): void {
  for (const [name, text] of derivedFiles(openapiText, asyncapiText)) {
    const target = join(OUT, name)

    if (existsSync(target) && readFileSync(target, 'utf8') === text) {
      continue
    }

    writeFileSync(target, text, 'utf8')
    process.stdout.write(['updated contracts/kap/', name, '\n'].join(''))
  }
}

async function main(): Promise<void> {
  /* 离线的先查：派生物与快照的矛盾不需要一台活着的 server 才能发现。 */
  if (check && verifyDerived()) {
    process.exit(1)
  }

  const token = readToken()
  const origin = readOrigin()

  mkdirSync(OUT, { recursive: true })

  let drifted = false
  let openapiText = ''
  let asyncapiText = ''

  for (const name of DOCS) {
    const next = await download(origin, token, name)

    if (name === 'openapi.json') {
      openapiText = next
    } else {
      asyncapiText = next
    }

    const target = join(OUT, name)
    const previous = existsSync(target) ? readFileSync(target, 'utf8') : ''

    if (previous === next) {
      continue
    }

    if (check) {
      process.stderr.write(`kap spec-sync: ${name} drifted from the pinned snapshot\n`)
      drifted = true
      continue
    }

    writeFileSync(target, next, 'utf8')
    process.stdout.write(['updated contracts/kap/', name, '\n'].join(''))
  }

  if (drifted) {
    process.exit(1)
  }

  /* 快照落定后连带派生：同一份文本算出，不经过第二次下载。 */
  if (!check) {
    writeDerived(openapiText, asyncapiText)
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write([reason(error), '\n'].join(''))
    process.exitCode = 1
  })
}
