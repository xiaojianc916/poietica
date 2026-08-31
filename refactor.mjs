#!/usr/bin/env node
/*
 * agent-catalog 单 agent 收敛。
 *
 * 「用哪一家 agent」不再是运行时状态：唯一真相是 packages/agent-catalog 里的
 * kimiCode 描述符，agents.json 只是它的一份物化。名单、按 id 定址的编解码器表、
 * 多档案协调、以及设置页那个只有一项的下拉，全部删除。
 *
 * 用法：node refactor.mjs
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const raw = String.raw

let applied = 0
let skipped = 0

function die(message) {
  console.error(`refactor: ${message}`)
  process.exit(1)
}

function full(rel) {
  return join(ROOT, rel.split(posix.sep).join(sep))
}

function read(rel) {
  const at = full(rel)

  if (!existsSync(at)) {
    die(`找不到文件：${rel}`)
  }

  return readFileSync(at, 'utf8')
}

/* 整份写入。内容逐字相同就是已经执行过。 */
function write(rel, content) {
  const at = full(rel)

  if (existsSync(at) && readFileSync(at, 'utf8') === content) {
    skipped += 1
    return
  }

  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, content, 'utf8')
  applied += 1
}

function drop(rel) {
  const at = full(rel)

  if (!existsSync(at)) {
    skipped += 1
    return
  }

  rmSync(at)
  applied += 1
}

function only(rel, source, needle, what) {
  const at = source.indexOf(needle)

  if (at < 0) {
    die(`${rel} 的${what}锚点没找到：\n${needle.split('\n')[0]}`)
  }

  if (source.indexOf(needle, at + needle.length) >= 0) {
    die(`${rel} 的${what}锚点不唯一：\n${needle.split('\n')[0]}`)
  }

  if (
    at > 0 &&
    needle.startsWith('\n') === false &&
    source[at - 1] !== '\n' &&
    needle.startsWith(' ')
  ) {
    die(`${rel} 的${what}锚点不在行首：\n${needle.split('\n')[0]}`)
  }

  return at
}

/* 从 start 所在处删到 stop 之前。两个锚点都必须唯一，且 stop 在 start 之后。 */
function cut(rel, source, start, stop) {
  const from = only(rel, source, start, '起始')
  const to = only(rel, source, stop, '终止')

  if (to <= from) {
    die(`${rel} 的终止锚点出现在起始锚点之前`)
  }

  return source.slice(0, from) + source.slice(to)
}

function swap(rel, source, find, replace) {
  const at = only(rel, source, find, '替换')

  return source.slice(0, at) + replace + source.slice(at + find.length)
}

function swapAll(rel, source, find, replace, count) {
  const seen = source.split(find).length - 1

  if (seen !== count) {
    die(`${rel} 里 ${find} 出现 ${String(seen)} 次，预期 ${String(count)} 次`)
  }

  return source.split(find).join(replace)
}

/*
 * 按「收敛判据」决定这一份要不要动。
 *
 * 判据成立就是已经执行过，整份跳过；不成立就必须把所有锚点走完，走完之后判据仍
 * 不成立即为半应用状态，报错退出。
 */
function patch(rel, settled, steps) {
  const source = read(rel)

  if (settled(source)) {
    skipped += 1
    return
  }

  let next = source

  for (const step of steps) {
    next = step(rel, next)
  }

  if (!settled(next)) {
    die(`${rel} 改完之后仍不满足收敛判据`)
  }

  write(rel, next)
}

const edit = (find, replace) => (rel, source) => swap(rel, source, find, replace)
const editAll = (find, replace, count) => (rel, source) =>
  swapAll(rel, source, find, replace, count)
const erase = (start, stop) => (rel, source) => cut(rel, source, start, stop)

/* ------------------------------------------------------------------ */
/* 退场的名字，以及写盘之后还允许出现它的地方。 */
/* ------------------------------------------------------------------ */

const NATIVE_BRIDGE = 'packages/native-bridge/src/gateways/agent-config.ts'
const NATIVE_STORE = 'packages/native-bridge/src/gateways/agent-config-store.ts'
const GENERATED_BINDINGS = 'packages/contract/src/generated/ipc-bindings.ts'

const RETIRED = [
  { name: 'agentRoster', keep: [] },
  { name: 'agentById', keep: [] },
  { name: 'agentCatalogCodec', keep: [] },
  { name: 'AgentCatalogCodec', keep: [] },
  { name: 'AgentProfileSet', keep: [] },
  { name: 'parseAgentProfileSet', keep: [] },
  { name: 'reconcileAgentProfiles', keep: [] },
  { name: 'builtinAgentProfile', keep: [] },
  { name: 'getAgentId', keep: [] },
  { name: 'subscribeAgent', keep: [] },
  { name: 'AGENT_SELECTION_UNAVAILABLE', keep: [] },
  /*
   * 生成物由 Rust 契约（profile.rs 的 agent_config_save_agents / AgentConfigSnapshot）
   * 派生：Rust 侧仍靠落盘的 defaultAgentId 定址档案，这一刀不进 Rust，所以线上的
   * 那一格保留 —— 这不是残留，见 NATIVE_STORE 里对 saveAgents 的调用。
   */
  { name: 'defaultAgentId', keep: [NATIVE_BRIDGE, GENERATED_BINDINGS] },
  { name: 'saveAgents', keep: [NATIVE_BRIDGE, NATIVE_STORE] },
]

/* 本次动到的文件。预检时它们不算违规 —— 它们的引用正是这次要改掉的。 */
const TOUCHED = [
  'packages/agent-catalog/src/index.ts',
  'packages/agent-catalog/src/agents.ts',
  'packages/agent-catalog/src/agent-profile.ts',
  'packages/agent-catalog/src/catalog-codec.ts',
  'packages/agent-catalog/src/catalog-contract.ts',
  'packages/agent-catalog/src/kimi/catalog.ts',
  'packages/agent-catalog/src/__tests__/agent-profile.test.ts',
  'packages/agent-catalog/src/__tests__/agent-profile-reconcile.test.ts',
  'packages/agent-catalog/src/__tests__/agent-profile-resolve.test.ts',
  'packages/agent-catalog/src/__tests__/builtin-agent-seed.test.ts',
  'packages/settings/src/agent-config-store.ts',
  NATIVE_STORE,
  'packages/surfaces/src/settings/models/models-settings.tsx',
  'packages/surfaces/src/settings/models/agent-models.tsx',
  'packages/surfaces/src/settings/models/use-agent-providers.ts',
  'packages/surfaces/src/settings/models/provider-key-card.tsx',
  'apps/desktop/src/entry/agent-runtime.ts',
  'apps/desktop/src/entry/compose-runtime.ts',
  'apps/desktop/src/notice/problem-presentation.ts',
  'apps/desktop/src/shell/app-shell.tsx',
]

const SCAN_ROOTS = ['apps', 'packages', 'tools']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', '.turbo', 'build'])

/* 按标识符整词匹配：subagentRosterTracker 不是退场的 agentRoster。 */
const retiredPattern = new RegExp(`\\b(?:${RETIRED.map((one) => one.name).join('|')})\\b`)

function sources() {
  const found = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) {
        continue
      }

      const at = join(dir, entry)

      if (statSync(at).isDirectory()) {
        walk(at)
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        found.push(at)
      }
    }
  }

  for (const root of SCAN_ROOTS) {
    const at = full(root)

    if (existsSync(at)) {
      walk(at)
    }
  }

  return found
}

function scan(stage, allowed) {
  const hits = []

  for (const at of sources()) {
    const rel = relative(ROOT, at).split(sep).join(posix.sep)

    if (allowed(rel)) {
      continue
    }

    const lines = readFileSync(at, 'utf8').split('\n')

    lines.forEach((line, index) => {
      if (!retiredPattern.test(line)) {
        return
      }

      for (const retired of RETIRED) {
        if (new RegExp(`\\b${retired.name}\\b`).test(line) && !retired.keep.includes(rel)) {
          hits.push(`${rel}:${String(index + 1)} ${retired.name}`)
        }
      }
    })
  }

  if (hits.length > 0) {
    console.error(`refactor: ${stage}`)

    for (const hit of hits) {
      console.error(`  ${hit}`)
    }

    process.exit(1)
  }
}

/* ------------------------------------------------------------------ */
/* 预检：这次要删的名字有没有出现在本次不动的文件里。 */
/* ------------------------------------------------------------------ */

scan('还有本次改动之外的调用点，先处理它们再重跑：', (rel) => TOUCHED.includes(rel))

/* ------------------------------------------------------------------ */
/* agent-catalog：名单、分派表、单实现接口退场 */
/* ------------------------------------------------------------------ */

drop('packages/agent-catalog/src/agents.ts')
drop('packages/agent-catalog/src/catalog-codec.ts')
drop('packages/agent-catalog/src/__tests__/agent-profile-reconcile.test.ts')
drop('packages/agent-catalog/src/__tests__/builtin-agent-seed.test.ts')

write(
  'packages/agent-catalog/src/index.ts',
  raw`/*
 * 这个包的唯一出口。
 *
 * 这台软件只接一家 agent，所以这里交出的是那一家本身，不是一张按 id 定址的名单：
 * 「用哪一家」不是运行时状态，它在编译期就已经确定。
 */

export type { AgentDescriptor } from './agent-descriptor'
export type {
  AgentConfigOptionValue,
  AgentProfile,
  AgentProfileResolution,
} from './agent-profile'
export { parseAgentProfile, resolveAgentProfile } from './agent-profile'
export { kimiCatalogCodec as agentCatalog } from './kimi/catalog'
export { kimiCode as agent } from './kimi/descriptor'
export { agentBareModelId, agentModelDisplayName } from './model-display'
export type { AgentProviderPreset } from './provider-presets'
export { builtinAgentProviderById, builtinAgentProviders } from './provider-presets'
export type { AgentModelState, AgentProviderSnapshot } from './provider-state'
export { parseAgentProviderListOutput } from './provider-state'
`,
)

write(
  'packages/agent-catalog/src/catalog-contract.ts',
  raw`/*
 * 「往 agent 的 provider 目录里加一家」这次请求说什么。
 *
 * 它是领域词汇而不是某一家 CLI 的参数表：怎么把它变成命令行，归 kimi/catalog-add.ts。
 */
export interface AgentCatalogAddRequest {
  readonly providerId: string
  readonly defaultModelId?: string
  readonly baseUrl?: string
}
`,
)

write(
  'packages/agent-catalog/src/agent-profile.ts',
  raw`import * as v from 'valibot'
import { kimiCode } from './kimi/descriptor'

/** 会话配置值。 */
export type AgentConfigOptionValue = string | boolean

/**
 * 这台机器上，这一家 agent 的接入档案。
 *
 * 前三格归用户，其余几格是 kimiCode 描述符往磁盘上的单向投影 —— 原生侧读的是磁盘上
 * 那几格，而名单在 TypeScript 里，那个进程读不到它。所以它们落盘，但磁盘上写着什么
 * 都不作数：每次解析都被描述符无条件盖掉。
 */
export interface AgentProfile {
  readonly id: string
  readonly cwd?: string | undefined
  /** 非敏感环境变量。密钥永远不在这里：它随一次 execCli 交给 agent 官方 CLI。 */
  readonly env: Readonly<Record<string, string>>
  readonly defaultConfigOptions: Readonly<Record<string, AgentConfigOptionValue>>
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly homeVar?: string | undefined
  readonly ownHomeDirectory?: string | undefined
  readonly install?: Readonly<{ packageName: string; versionArgs: readonly string[] }> | undefined
}

export type AgentProfileParse =
  | { readonly ok: true; readonly profile: AgentProfile }
  | { readonly ok: false; readonly issue: string }

/** 一次解析的全部结论：用哪一份、要不要写回、有什么没能用上。 */
export interface AgentProfileResolution {
  readonly profile: AgentProfile
  /** 磁盘上那份与这一份不一致，调用方应当把它物化下去。 */
  readonly materialize: boolean
  /** 配置里有东西没能用上。界面要说出来，不能默默改用户的文件。 */
  readonly issues: readonly string[]
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_TEXT = 512
const MAX_ENTRIES = 32

const ID_ISSUE = 'agent 标识只允许小写字母、数字与连字符，且以字母开头'
const PROFILE_ISSUE = 'agent 档案无法解析'
const FOREIGN_ISSUE = '配置里有不属于本软件的 agent 档案，已从 agents.json 移除'
const DUPLICATE_ISSUE = '配置里有重复的 agent 档案，只保留了第一条'

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TEXT))
const envName = v.pipe(v.string(), v.regex(ENV_NAME_PATTERN))

const ProfileSchema = v.object({
  id: v.pipe(v.string(), v.regex(ID_PATTERN)),
  cwd: v.optional(text),
  env: v.record(envName, text),
  defaultConfigOptions: v.record(text, v.union([text, v.boolean()])),
  command: v.optional(text),
  args: v.optional(v.array(text)),
  homeVar: v.optional(envName),
  ownHomeDirectory: v.optional(text),
  install: v.optional(v.object({ packageName: text, versionArgs: v.array(text) })),
})

function idOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || !('id' in entry)) {
    return undefined
  }

  const id = (entry as { id: unknown }).id

  return typeof id === 'string' ? id : undefined
}

/** 校验一条档案。表的条目数在这里判：它是这份文件自己的门槛，不是 schema 的形状。 */
export function parseAgentProfile(input: unknown): AgentProfileParse {
  const id = idOf(input)

  if (id === undefined || !ID_PATTERN.test(id)) {
    return { ok: false, issue: ID_ISSUE }
  }

  const parsed = v.safeParse(ProfileSchema, input)

  if (!parsed.success) {
    return { ok: false, issue: PROFILE_ISSUE }
  }

  const profile = parsed.output

  if (
    Object.keys(profile.env).length > MAX_ENTRIES ||
    Object.keys(profile.defaultConfigOptions).length > MAX_ENTRIES
  ) {
    return { ok: false, issue: PROFILE_ISSUE }
  }

  return { ok: true, profile }
}

/** 用户那几格还是空的那一份。 */
function blankProfile(): AgentProfile {
  return {
    id: kimiCode.id,
    cwd: undefined,
    env: {},
    defaultConfigOptions: {},
    command: kimiCode.command,
    args: kimiCode.args,
    homeVar: kimiCode.homeVar,
    ownHomeDirectory: kimiCode.ownHomeDirectory,
    install: kimiCode.install,
  }
}

function sameArgs(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined && left.length === right.length && left.every((one, at) => one === right[at])
  )
}

function sameInstall(left: AgentProfile['install'], right: AgentProfile['install']): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }

  return left.packageName === right.packageName && sameArgs(left.versionArgs, right.versionArgs)
}

/*
 * 把归二进制的那几格对齐到描述符。覆盖是无条件的，不是合并。
 *
 * 已经一致时原样返回同一个对象：调用方靠引用变化判断要不要写盘，复制一份会让每次
 * 启动都白写一次磁盘。
 */
function projected(profile: AgentProfile): AgentProfile {
  const aligned =
    profile.command === kimiCode.command &&
    sameArgs(profile.args, kimiCode.args) &&
    profile.homeVar === kimiCode.homeVar &&
    profile.ownHomeDirectory === kimiCode.ownHomeDirectory &&
    sameInstall(profile.install, kimiCode.install)

  return aligned
    ? profile
    : {
        ...profile,
        command: kimiCode.command,
        args: kimiCode.args,
        homeVar: kimiCode.homeVar,
        ownHomeDirectory: kimiCode.ownHomeDirectory,
        install: kimiCode.install,
      }
}

/**
 * 磁盘上那一份数组，收敛成这一家 agent 的档案。
 *
 * 这里是「agents.json 该怎么算」的唯一一处规则：取自己那条、校验、投影、把别家的
 * 条目连原因一起交出去。谁来写盘不在这里决定 —— 这一层不认识 IPC。
 */
export function resolveAgentProfile(stored: readonly unknown[]): AgentProfileResolution {
  const own = stored.filter((entry) => idOf(entry) === kimiCode.id)
  const issues: string[] = []

  if (own.length !== stored.length) {
    issues.push(FOREIGN_ISSUE)
  }

  if (own.length > 1) {
    issues.push(DUPLICATE_ISSUE)
  }

  const first = own[0]

  if (first === undefined) {
    /* 第一次启动：文件还没写过，这不是配置有问题，所以不报 issue。 */
    return { profile: blankProfile(), materialize: true, issues }
  }

  const parsed = parseAgentProfile(first)

  if (!parsed.ok) {
    /* 被手改坏了：内存里用内置档案让界面照常可用，但不写回 —— 那等于替用户删文件。 */
    return { profile: blankProfile(), materialize: false, issues: [...issues, parsed.issue] }
  }

  const aligned = projected(parsed.profile)

  return { profile: aligned, materialize: issues.length > 0 || aligned !== parsed.profile, issues }
}
`,
)

patch(
  'packages/agent-catalog/src/kimi/catalog.ts',
  (source) => !source.includes('AgentCatalogCodec'),
  [
    edit(
      raw`import type { AgentCatalogCodec } from '../catalog-contract'
`,
      '',
    ),
    edit(
      raw` *
 * 这些函数此前住在 builtin-catalog.ts —— 一个名叫「内置厂商清单」的通用模块里。
 * 它们产出的却是一家的私有形状：判据是 @moonshot-ai/kosong 的 src/catalog.ts
 * 逐字读什么、handleCatalogAdd 逐字校验什么（原注释自己写着这两条）。
 *
 * 现在它属于这一家自己，而且只对外交出一样东西：下面那个 kimiCatalogCodec。函数名
 * 因此不再带 agentProvider / builtin 这类通用前缀 —— 在这个目录里它们本来就只可能是
 * kimi 的，前缀只会让人以为通用层能直接调它们（上一刀之前正是如此）。
 */`,
      raw` */`,
    ),
    edit(
      raw`/* 这一家对外的全部：一个编解码器。通用层从 catalog-codec.ts 按 agentId 取到它。 */
export const kimiCatalogCodec: AgentCatalogCodec = {`,
      raw`/* 这一家对外的全部：一个编解码器。 */
export const kimiCatalogCodec = {`,
    ),
  ],
)

write(
  'packages/agent-catalog/src/__tests__/agent-profile.test.ts',
  raw`import { describe, expect, it } from 'bun:test'
import { parseAgentProfile } from '../agent-profile'

const valid = {
  id: 'kimi',
  env: { NO_COLOR: '1' },
  defaultConfigOptions: { model: 'kimi-k2-turbo-preview', brave_mode: false },
}

describe('parseAgentProfile', () => {
  it('接受一份只有用户那几格的档案', () => {
    const parsed = parseAgentProfile(valid)

    expect(parsed.ok).toBe(true)
  })

  it('接受 Windows 风格的工作目录', () => {
    const parsed = parseAgentProfile({ ...valid, cwd: 'C:\\my notes' })

    expect(parsed.ok).toBe(true)
  })

  it('拒绝不合法的 agent 标识', () => {
    const parsed = parseAgentProfile({ ...valid, id: 'Kimi Code' })

    expect(parsed.ok).toBe(false)
  })

  it('拒绝不合法的环境变量名', () => {
    const parsed = parseAgentProfile({ ...valid, env: { 'no-color': '1' } })

    expect(parsed.ok).toBe(false)
  })

  it('拒绝既不是字符串也不是布尔的会话配置值', () => {
    const parsed = parseAgentProfile({ ...valid, defaultConfigOptions: { model: 3 } })

    expect(parsed.ok).toBe(false)
  })

  it('拒绝不是对象的东西', () => {
    expect(parseAgentProfile(null).ok).toBe(false)
    expect(parseAgentProfile('kimi').ok).toBe(false)
  })
})
`,
)

write(
  'packages/agent-catalog/src/__tests__/agent-profile-resolve.test.ts',
  raw`import { describe, expect, it } from 'bun:test'
import { parseAgentProfile, resolveAgentProfile } from '../agent-profile'
import { kimiCode } from '../kimi/descriptor'

/*
 * agents.json 是 kimiCode 描述符的一份物化，不是第二个来源。
 *
 * 用户那几格原样保留；原生侧要读的那几格每次无条件盖回 —— 它读的是磁盘，而名单在
 * 这个进程里。
 */
const stored = {
  id: kimiCode.id,
  env: {},
  defaultConfigOptions: {},
  command: kimiCode.command,
  args: [...kimiCode.args],
  homeVar: kimiCode.homeVar,
  ownHomeDirectory: kimiCode.ownHomeDirectory,
  install: {
    packageName: kimiCode.install.packageName,
    versionArgs: [...kimiCode.install.versionArgs],
  },
}

describe('resolveAgentProfile', () => {
  it('磁盘为空时给出内置档案，并要求物化', () => {
    const resolved = resolveAgentProfile([])

    expect(resolved.profile.id).toBe(kimiCode.id)
    expect(resolved.materialize).toBe(true)
    expect(resolved.issues).toEqual([])
  })

  it('与描述符一致时不写盘', () => {
    const resolved = resolveAgentProfile([stored])

    expect(resolved.materialize).toBe(false)
    expect(resolved.issues).toEqual([])
  })

  it('用户自己那几格原样保留', () => {
    const resolved = resolveAgentProfile([
      { ...stored, cwd: '/work', env: { EXTRA: '1' }, defaultConfigOptions: { brave_mode: true } },
    ])

    expect(resolved.profile.cwd).toBe('/work')
    expect(resolved.profile.env).toEqual({ EXTRA: '1' })
    expect(resolved.profile.defaultConfigOptions).toEqual({ brave_mode: true })
  })

  it('手写进磁盘的启动命令活不过一次解析', () => {
    const resolved = resolveAgentProfile([{ ...stored, command: 'rm' }])

    expect(resolved.profile.command).toBe(kimiCode.command)
    expect(resolved.materialize).toBe(true)
  })

  it('别家 agent 的档案被移除，并说出原因', () => {
    const resolved = resolveAgentProfile([
      stored,
      { id: 'homemade', env: {}, defaultConfigOptions: {} },
    ])

    expect(resolved.profile.id).toBe(kimiCode.id)
    expect(resolved.materialize).toBe(true)
    expect(resolved.issues).toHaveLength(1)
  })

  it('档案被改坏时照常可用，但不写回磁盘', () => {
    const resolved = resolveAgentProfile([{ ...stored, env: { 'not-an-env': '1' } }])

    expect(resolved.materialize).toBe(false)
    expect(resolved.issues).toHaveLength(1)
    expect(resolved.profile.command).toBe(kimiCode.command)
  })

  it('物化出去的那一份自己能过校验，且原生侧要读的格子齐全', () => {
    const materialized = resolveAgentProfile([]).profile

    expect(parseAgentProfile(materialized).ok).toBe(true)
    expect(Object.keys(materialized).sort()).toEqual([
      'args',
      'command',
      'cwd',
      'defaultConfigOptions',
      'env',
      'homeVar',
      'id',
      'install',
      'ownHomeDirectory',
    ])
  })
})
`,
)

/* ------------------------------------------------------------------ */
/* 端口：快照说的是一份档案，写盘不再是 UI 的动作 */
/* ------------------------------------------------------------------ */

patch(
  'packages/settings/src/agent-config-store.ts',
  (source) => source.includes('readonly profile: AgentProfile') && !source.includes('saveAgents'),
  [
    edit(
      raw`export interface AgentConfigSnapshot {
  readonly agents: readonly AgentProfile[]
  readonly defaultAgentId: string`,
      raw`export interface AgentConfigSnapshot {
  /** 这一家 agent 在这台机器上的接入档案。 */
  readonly profile: AgentProfile`,
    ),
    edit(
      raw`  readonly load: () => Promise<AgentConfigSnapshot>
  readonly saveAgents: (args: {
    readonly agents: readonly AgentProfile[]
    readonly defaultAgentId: string
  }) => Promise<AgentConfigSnapshot>`,
      raw`  readonly load: () => Promise<AgentConfigSnapshot>`,
    ),
  ],
)

write(
  NATIVE_STORE,
  raw`import { agent, resolveAgentProfile } from '@poietica/agent-catalog'
import type { AgentConfigSnapshot, AgentConfigStore } from '@poietica/settings'
import { createAgentConfigBridge } from './agent-config'

/*
 * agent 接入配置在桌面端的存储。
 *
 * 边界上有一处真实的翻译：Rust 侧把 agents 当不透明数组原样存取，而端口说的是这一家
 * agent 的档案。校验只能落在这里 —— agents.json 可以被手改，一个被改坏的档案不应该
 * 变成一次任意命令执行。怎么算由 resolveAgentProfile 说，这一层只负责读写。
 */
export function createAgentConfigStore(): AgentConfigStore {
  const bridge = createAgentConfigBridge()

  /*
   * 「agent 自己的配置被改过了」的听众。存在这里而不是模块级单例：这个 store 一个
   * 进程一份，通道的作用域就该是它的作用域。
   */
  const listeners = new Set<() => void>()

  return {
    async load(): Promise<AgentConfigSnapshot> {
      const dto = await bridge.load()
      const resolved = resolveAgentProfile(dto.agents)

      /*
       * 档案的身份由二进制拥有，agents.json 只是它的一份物化 —— 所以每次读都重新
       * 物化。物化自己产生的说明要一起交出去：写回之后再读，那一行已经不在文件里。
       */
      if (resolved.materialize) {
        const written = await bridge.saveAgents([resolved.profile], agent.id)

        return { profile: resolved.profile, issues: [...written.issues, ...resolved.issues] }
      }

      return { profile: resolved.profile, issues: [...dto.issues, ...resolved.issues] }
    },

    /* 请求与结果两侧同名同类型，没有可翻译的东西，翻一遍只会多一个出错的地方。 */
    execCli(invocation) {
      return bridge.execCli(invocation)
    },

    loadKeyTails: (agentId) => bridge.loadKeyTails(agentId),

    loadDefaultModel: (agentId) => bridge.loadDefaultModel(agentId),

    saveDefaultModel: (agentId, alias) => bridge.saveDefaultModel(agentId, alias),

    loadInstallStatus: (agentId, options) =>
      bridge.loadInstallStatus(agentId, options?.force ?? false),

    runInstall: (agentId) => bridge.runInstall(agentId),

    verifyProviderKey: ({ baseUrl, secret }) => bridge.verifyProviderKey(baseUrl, secret),

    notifyConfigChanged() {
      for (const listener of listeners) {
        listener()
      }
    },

    subscribeConfigChanged(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}
`,
)

/* ------------------------------------------------------------------ */
/* 设置页：没有「选哪一家」这个动作 */
/* ------------------------------------------------------------------ */

write(
  'packages/surfaces/src/settings/models/models-settings.tsx',
  raw`import { agent } from '@poietica/agent-catalog'
import type { AgentConfigStore } from '@poietica/settings'
import { useEffect, useState } from 'react'
import { describeAgentCliFailure } from '../agent-install/agent-cli-text'
import { AgentInstallAction } from '../agent-install/agent-install-action'
import { AgentModels } from './agent-models'
import './models-settings.css'

/*
 * 设置 · 模型的外壳。
 *
 * 这台软件只接一家 agent，所以这一页没有「选哪一家」这个动作：上面那张卡说的是它装好
 * 了没有，下面整页是它的模型与密钥。也不需要「保存」—— 显示的就是 agent 此刻的真实配置。
 */

export interface ModelsSettingsProps {
  readonly store: AgentConfigStore
}

export function ModelsSettings({ store }: ModelsSettingsProps) {
  const [agentError, setAgentError] = useState<string | null>(null)

  /*
   * 读一次落盘的配置。这一趟唯一的产出是「配置里有什么没能用上」：档案本身由 store
   * 在这次读取里物化，界面不持有它的副本。
   *
   * active 标志防的是两次往返先后颠倒，不是「卸载后 setState」。
   */
  useEffect(() => {
    let active = true

    void store.load().then(
      (snapshot) => {
        if (active) {
          setAgentError(snapshot.issues.length > 0 ? snapshot.issues.join('；') : null)
        }
      },
      (cause: unknown) => {
        if (active) {
          setAgentError(describeAgentCliFailure(cause, 'agent 配置读取失败，请重试。'))
        }
      },
    )

    return () => {
      active = false
    }
  }, [store])

  return (
    <section className="models-page">
      <div className="models-block">
        <span className="models-block__label">智能体</span>

        <div className="models-card">
          <div className="models-row">
            <div className="models-row__copy">
              <strong>{agent.displayName}</strong>
              <p>{agentError ?? '本软件的对话由它提供，可用模型与密钥都归它'}</p>
            </div>

            <div className="models-row__control">
              <AgentInstallAction agentId={agent.id} store={store} />
            </div>
          </div>
        </div>
      </div>

      <AgentModels agentId={agent.id} registryKeyVar={agent.registryKeyVar} store={store} />
    </section>
  )
}
`,
)

patch(
  'packages/surfaces/src/settings/models/use-agent-providers.ts',
  (source) => !source.includes('agentById'),
  [
    edit(
      raw`import {
  type AgentProviderSnapshot,
  agentById,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'`,
      raw`import {
  type AgentProviderSnapshot,
  agent,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'`,
    ),
    edit(
      raw` *
 * 缓存按 agentId 分键：换 agent 时看到的是它自己的上一份，不是上一家 agent 的。
 *
`,
      raw` *
`,
    ),
    edit(
      raw`const lastGood = new Map<string, AgentProviderSnapshot>()`,
      raw`let lastGood: AgentProviderSnapshot | undefined`,
    ),
    edit(
      raw`  const [loading, setLoading] = useState(() => !lastGood.has(agentId))
  const [snapshot, setSnapshot] = useState<AgentProviderSnapshot | undefined>(() =>
    lastGood.get(agentId),
  )`,
      raw`  const [loading, setLoading] = useState(() => lastGood === undefined)
  const [snapshot, setSnapshot] = useState<AgentProviderSnapshot | undefined>(() => lastGood)`,
    ),
    erase(
      raw`    /*
     * 问什么、以及哪个 id 是环境变量合成的保留条目，都写在 agent 的档案里。`,
      raw`    /*
     * 有缓存先摆缓存，后台再真问`,
    ),
    edit(raw`    const cached = lastGood.get(agentId)`, raw`    const cached = lastGood`),
    edit(raw`        args: [...listArgs],`, raw`        args: [...agent.providerListArgs],`),
    edit(
      raw`          const next = parseAgentProviderListOutput(outcome.stdout, descriptor.syntheticProviderId)`,
      raw`          const next = parseAgentProviderListOutput(outcome.stdout, agent.syntheticProviderId)`,
    ),
    edit(raw`          lastGood.set(agentId, next)`, raw`          lastGood = next`),
  ],
)

patch(
  'packages/surfaces/src/settings/models/agent-models.tsx',
  (source) => !source.includes('agentById') && !source.includes('agentCatalogCodec'),
  [
    edit(
      raw`import {
  type AgentCatalogCodec,
  type AgentModelState,
  type AgentProviderSnapshot,
  agentById,
  agentCatalogCodec,
  agentModelDisplayName,
  builtinAgentProviders,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'`,
      raw`import {
  type AgentModelState,
  type AgentProviderSnapshot,
  agent,
  agentCatalog,
  agentModelDisplayName,
  builtinAgentProviders,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'`,
    ),
    edit(
      raw`/*
 * 一家 agent 的模型页。
 *
 * 这里的每一格状态都只对一家 agent 成立：它报回来的模型、它的密钥尾号、从全局配置
 * 探到的待导入清单、正在删哪一行、搜索词、展开与否。换一家 agent，它们全部作废。
 *
 * 作废由 React 自己做：外壳以 key={agentId} 挂载这棵子树（官方文档 Preserving and
 * Resetting State 里 "Resetting state with a key" 的原样用法）。此前这些状态与外壳
 * 挤在一个组件里，换 agent 只改一个字符串，于是：
 *
 * - 在 A 上「导入配置」探出一份清单，切到 B，那条横幅仍在屏幕上；点「确认导入」时
 *   runImport 读的是当前的 agentId（B），喂的却是 A 的 globalSnapshot —— 把 A 的
 *   provider 导进 B；
 * - keyTails、confirmId、importNote 同理，都会跨 agent 留在屏幕上。
 *
 * 三套手写的「过期响应」防护也在这里退场两套：卡片里的 mounted ref 拦的是卸载，拦不住
 * 上面这些（那时组件根本没卸载）；外壳里的 active 标志同理。整棵子树重建之后，在飞的
 * 回执落在已卸载的树上，React 自己丢掉。留下的只有 keyTails 那一处 ignore 标志 ——
 * 它防的是同一棵树内两次往返的先后颠倒，key 管不到那件事。
 */`,
      raw`/*
 * 这一家 agent 的模型页：它报回来的模型、它的密钥尾号、从全局配置探到的待导入清单、
 * 正在删哪一行、搜索词、展开与否。
 *
 * keyTails 那一处 active 标志防的是同一棵树内两次往返先后颠倒，不是「卸载后 setState」。
 */`,
    ),
    edit(
      raw`  readonly agentId: string
  readonly codec: AgentCatalogCodec
  readonly defaultModelId: string | undefined`,
      raw`  readonly agentId: string
  readonly defaultModelId: string | undefined`,
    ),
    edit(
      raw`  const { agentId, codec, defaultModelId, provider, registryKeyVar, store } = input`,
      raw`  const { agentId, defaultModelId, provider, registryKeyVar, store } = input`,
    ),
    edit(raw`      args: codec.catalogAddArgs({`, raw`      args: agentCatalog.catalogAddArgs({`),
    edit(
      raw`      catalogDocument: codec.importDocument(provider),`,
      raw`      catalogDocument: agentCatalog.importDocument(provider),`,
    ),
    edit(
      raw`  /** 档案声明的注入变量名。缺席时不写入，而不是自己挑一个名字。 */
  readonly registryKeyVar: string | undefined
}`,
      raw`  /** 档案声明的注入变量名。 */
  readonly registryKeyVar: string
}`,
    ),
    edit(
      raw`/*
 * 这里只画随所选 agent 一起作废的东西 —— 那正是外壳用 key 圈起来的范围。
 *
 * 选 agent 的下拉与「智能体」那张卡都跨 agent，搬回外壳了：它们此前渲染在这棵子树
 * 里，而这棵子树正是它们自己按一下就会重建的那一棵。
 */
export function AgentModels`,
      raw`export function AgentModels`,
    ),
    erase(
      raw`    /* 问什么写在档案里。在这里再抄一遍，就是第二个迟早走样的说法。 */`,
      raw`    setProbing(true)`,
    ),
    edit(raw`        args: [...listArgs],`, raw`        args: [...agent.providerListArgs],`),
    edit(
      raw`          const snapshot = parseAgentProviderListOutput(
            outcome.stdout,
            descriptor.syntheticProviderId,
          )`,
      raw`          const snapshot = parseAgentProviderListOutput(outcome.stdout, agent.syntheticProviderId)`,
    ),
    edit(
      raw`    if (registryKeyVar === undefined) {
      setImportNote('这个 agent 没有声明该往哪个环境变量注入密钥，无法导入。')
      return
    }

    /*
     * 目录写成什么形状归这一家的编解码器。缺席就是"说不出"，于是这次导入不发生 ——
     * 与上面那条判据同构，也是我们对"这一家不支持"的统一处置。
     */
    const codec = agentCatalogCodec(agentId)

    if (codec === undefined) {
      setImportNote('这个 agent 没有声明该怎么写入 provider 目录，无法导入。')
      return
    }

`,
      '',
    ),
    edit(
      raw`      (provider) => codec.defaultModelId(provider) !== undefined,`,
      raw`      (provider) => agentCatalog.defaultModelId(provider) !== undefined,`,
    ),
    edit(
      raw`          agentId,
          codec,
          defaultModelId:
            provider === defaultModelOwner ? codec.defaultModelId(provider) : undefined,`,
      raw`          agentId,
          defaultModelId:
            provider === defaultModelOwner ? agentCatalog.defaultModelId(provider) : undefined,`,
    ),
    edit(
      raw`      {/*
       * agent 自己报回来的配置问题，说在它的清单旁边。
       *
       * 此前它和 agents.json 的错误挤在「ACP Agent」那张卡的副标题里三选一 ——
       * 两个来源、一个位置，谁盖住谁全看当时哪一个不是 null。
       */}`,
      raw`      {/* agent 自己报回来的配置问题，说在它的清单旁边。 */}`,
    ),
  ],
)

patch(
  'packages/surfaces/src/settings/models/provider-key-card.tsx',
  (source) => !source.includes('agentCatalogCodec') && !source.includes('AgentCatalogCodec'),
  [
    edit(
      raw`import {
  type AgentCatalogCodec,
  type AgentProviderPreset,
  agentCatalogCodec,
} from '@poietica/agent-catalog'`,
      raw`import { type AgentProviderPreset, agentCatalog } from '@poietica/agent-catalog'`,
    ),
    edit(
      raw`  /** 档案声明的注入变量名。缺席时不写入，而不是自己挑一个名字。 */
  readonly registryKeyVar: string | undefined`,
      raw`  /** 档案声明的注入变量名。 */
  readonly registryKeyVar: string`,
    ),
    edit(
      raw`  /*
   * 这里没有「卸载后不 setState」那道守卫。
   *
   * React 18 起「卸载后 setState」不再是错误，那条警告本身已被官方删掉
   * （facebook/react#22114）。而它真该防的那件事它也防不住：这张卡的 key 是
   * provider id，换 agent 时组件不重建，于是在 A 上按下保存、立刻切到 B，回执会
   * 落在 B 的界面上 —— 那一刻组件还挂着，任何按卸载判断的守卫都会放行。换 agent
   * 的作废由外壳的 key={agentId} 整棵重建来做，见 AgentModels。
   */`,
      raw`  /*
   * 这里没有「卸载后不 setState」那道守卫：React 18 起它不再是错误，官方也删掉了那
   * 条警告（facebook/react#22114）。
   */`,
    ),
    edit(
      raw`   * 没有最小展示时长、请求没发出去就一次都不转（变量名缺席、密钥为空都在 setBusy 之前
   * return 了）。`,
      raw`   * 没有最小展示时长、请求没发出去就一次都不转（密钥为空在 setBusy 之前 return 了）。`,
    ),
    edit(
      raw`    (keyVar: string, secret: string, probe: ProviderKeyProbe, catalog: AgentCatalogCodec) => {`,
      raw`    (keyVar: string, secret: string, probe: ProviderKeyProbe) => {`,
    ),
    edit(
      raw`          const seed = existing === null ? catalog.presetDefaultModelId(provider) : undefined`,
      raw`          const seed = existing === null ? agentCatalog.presetDefaultModelId(provider) : undefined`,
    ),
    edit(
      raw`            args = catalog.catalogAddArgs({`,
      raw`            args = agentCatalog.catalogAddArgs({`,
    ),
    edit(
      raw`              catalogDocument: catalog.catalogDocument([provider]),`,
      raw`              catalogDocument: agentCatalog.catalogDocument([provider]),`,
    ),
    edit(
      raw`    if (registryKeyVar === undefined) {
      setMessage('这个 agent 没有声明该往哪个环境变量注入密钥，无法从这里写入。')
      return
    }

    const secret = apiKey.trim()`,
      raw`    const secret = apiKey.trim()`,
    ),
    erase(
      raw`    /*
     * 早退之后 registryKeyVar 已经不是 undefined 了`,
      raw`    setBusy(true)`,
    ),
    edit(
      raw`        write(keyVar, secret, probe, catalog)`,
      raw`        write(registryKeyVar, secret, probe)`,
    ),
  ],
)

/* ------------------------------------------------------------------ */
/* 桌面端：运行时不再持有「选了哪一家」 */
/* ------------------------------------------------------------------ */

patch(
  'apps/desktop/src/entry/agent-runtime.ts',
  (source) => !source.includes('agentRoster') && !source.includes('selectedAgent'),
  [
    edit(
      raw`import type { AgentDescriptor } from '@poietica/agent-catalog'
import { agentById, agentRoster, parseAgentProviderListOutput } from '@poietica/agent-catalog'`,
      raw`import { agent, parseAgentProviderListOutput } from '@poietica/agent-catalog'`,
    ),
    edit(
      raw`import { createExternalStore, createPreference } from '@poietica/external-store'`,
      raw`import { createPreference } from '@poietica/external-store'`,
    ),
    edit(
      raw`  readonly cwd: NonNullable<AgentBridgeOptions['cwd']>
  readonly onSelectionFailure: (cause: unknown) => void
  readonly onSelectionReady: () => void
}`,
      raw`  readonly cwd: NonNullable<AgentBridgeOptions['cwd']>
}`,
    ),
    edit(
      raw`  readonly getAgentId: () => string
  readonly subscribeAgent: (listener: () => void) => () => void
  readonly capabilities: (agentId: string) => AgentCapabilityPort`,
      raw`  readonly capabilities: () => AgentCapabilityPort`,
    ),
    erase(
      raw`function requireAgent(agentId: string): AgentDescriptor {`,
      raw`function noteListenFailure(cause: unknown): void {`,
    ),
    edit(
      raw`  const fallback = agentRoster()[0]

  if (fallback === undefined) {
    throw new Error('At least one Agent profile must be registered.')
  }

  let selected = fallback
  let selectionResolved = false
  let selectionFailure: unknown
  let generation = 0
  let disposed = false
  let pending: Promise<void> = Promise.resolve()

  const selection = createExternalStore<string>({ read: () => selected.id })

  const reloadSelection = (): void => {
    const mine = generation + 1
    generation = mine

    pending = options.config
      .load()
      .then((snapshot) => {
        if (disposed || generation !== mine) {
          return
        }

        const next = requireAgent(snapshot.defaultAgentId)
        const changed = next.id !== selected.id

        selected = next
        selectionResolved = true
        selectionFailure = undefined
        options.onSelectionReady()

        if (changed) {
          selection.notify()
        }
      })
      .catch((cause: unknown) => {
        if (disposed || generation !== mine) {
          return
        }

        selectionResolved = false
        selectionFailure = cause
        options.onSelectionFailure(cause)
      })
  }

  reloadSelection()
  const stopConfig = options.config.subscribeConfigChanged(reloadSelection)

  const selectedAgent = async (): Promise<AgentDescriptor> => {
    /* 等已发出的那一趟落地就够。自旋等「没有新一趟」会被连续的配置变更饿死。 */
    await pending

    if (!selectionResolved) {
      throw new Error('The selected Agent profile could not be loaded.', {
        cause: selectionFailure,
      })
    }

    return selected
  }

`,
      raw`  let disposed = false

`,
    ),
    edit(
      raw`    return { agentId: (await selectedAgent()).id }
  }`,
      raw`    return { agentId: agent.id }
  }`,
    ),
    edit(
      raw`  const alignThinking = async (
    agentId: string,
    controls: readonly SessionConfigControl[],`,
      raw`  const alignThinking = async (
    controls: readonly SessionConfigControl[],`,
    ),
    edit(
      raw`    const preferred = thinking.selection(agentId, controls)`,
      raw`    const preferred = thinking.selection(agent.id, controls)`,
    ),
    edit(
      raw`   * 归属在写之前重验：往返期间设置页可能换过 agent，那时这个别名不属于现在这一家。
   * 锚会话与对话内两条路共用这一条落账，不再各写一遍。
   */
  const commitSelection = async (
    agentId: string,
    controls: readonly SessionConfigControl[],`,
      raw`   * 锚会话与对话内两条路共用这一条落账，不再各写一遍。
   */
  const commitSelection = async (
    controls: readonly SessionConfigControl[],`,
    ),
    edit(
      raw`    if ((await selectedAgent()).id !== agentId) {
      throw new Error('Agent selection changed before the configuration change completed.')
    }

    if (accepted.purpose === 'model') {
      await options.config.saveDefaultModel(agentId, value)
    }

    thinking.remember(agentId, controls, controlId, value)

    return alignThinking(agentId, controls, select)`,
      raw`    if (accepted.purpose === 'model') {
      await options.config.saveDefaultModel(agent.id, value)
    }

    thinking.remember(agent.id, controls, controlId, value)

    return alignThinking(controls, select)`,
    ),
    edit(
      raw`   * 没设过默认模型时补一个，每家一次，且不挡住读表。`,
      raw`   * 没设过默认模型时补一个，一个进程一次，且不挡住读表。`,
    ),
    edit(
      raw`  const seeded = new Set<string>()

  const seedDefaultModel = (agentId: string): void => {
    if (seeded.has(agentId)) {
      return
    }

    seeded.add(agentId)

    void firstUsableModel(options.config, agentId)
      .then(async (alias) => {
        if (alias !== undefined) {
          await options.config.saveDefaultModel(agentId, alias)
        }
      })
      .catch((cause: unknown) => {
        seeded.delete(agentId)`,
      raw`  let seeded = false

  const seedDefaultModel = (): void => {
    if (seeded) {
      return
    }

    seeded = true

    void firstUsableModel(options.config)
      .then(async (alias) => {
        if (alias !== undefined) {
          await options.config.saveDefaultModel(agent.id, alias)
        }
      })
      .catch((cause: unknown) => {
        seeded = false`,
    ),
    edit(
      raw`      const agentId = (await selectedAgent()).id
      const controls = await sessionConfigBridge.select(threadId, configId, value, input)

      return commitSelection(agentId, controls, configId, value, (control, preferred) =>`,
      raw`      const controls = await sessionConfigBridge.select(threadId, configId, value, input)

      return commitSelection(controls, configId, value, (control, preferred) =>`,
    ),
    edit(
      raw`    const agent = await selectedAgent()
    const selectors = await alignThinking(agent.id, opened.selectors, (control, value) =>`,
      raw`    const selectors = await alignThinking(opened.selectors, (control, value) =>`,
    ),
    edit(
      raw`  const capabilityPorts = new Map<string, AgentCapabilityPort>()

  const capabilities = (agentId: string): AgentCapabilityPort => {
    const held = capabilityPorts.get(agentId)

    if (held !== undefined) {
      return held
    }

    const currentAgent = async (): Promise<AgentDescriptor> => {
      const current = await selectedAgent()

      if (current.id !== agentId) {
        throw new Error('Agent selection changed before the capability request completed.')
      }

      return current
    }

    const anchor = createAgentCapabilityBridge({
      cwd: options.cwd,
      launch: async () => {
        await hostedMcpServersReady

        return { agentId: (await currentAgent()).id }
      },
      onListenFailure: noteListenFailure,
    })

    const source: AgentCapabilityPort = {
      read: async () => {
        await currentAgent()
        seedDefaultModel(agentId)

        return alignThinking(agentId, await anchor.read(), (control, value) =>
          anchor.select(control, value),
        )
      },
      select: async (control, value) => {
        await currentAgent()

        /* select 的答复就是权威表，不再回读：回读拿到的是这次写入之前的那一张。 */
        return commitSelection(
          agentId,
          await anchor.select(control, value),
          control.id,
          value,
          (candidate, preferred) => anchor.select(candidate, preferred),
        )
      },
      readToolkit: async (threadId) => {
        await currentAgent()
        return readToolkit(threadId)
      },
      subscribe: anchor.subscribe,
    }

    capabilityPorts.set(agentId, source)
    return source
  }`,
      raw`  /* 端口一个进程一份：它有身份（start() 返回退订），每次新建就多一份订阅。 */
  let capabilityPort: AgentCapabilityPort | undefined

  const capabilities = (): AgentCapabilityPort => {
    if (capabilityPort !== undefined) {
      return capabilityPort
    }

    const anchor = createAgentCapabilityBridge({
      cwd: options.cwd,
      launch: launchSelected,
      onListenFailure: noteListenFailure,
    })

    capabilityPort = {
      read: async () => {
        seedDefaultModel()

        return alignThinking(await anchor.read(), (control, value) => anchor.select(control, value))
      },
      /* select 的答复就是权威表，不再回读：回读拿到的是这次写入之前的那一张。 */
      select: async (control, value) =>
        commitSelection(
          await anchor.select(control, value),
          control.id,
          value,
          (candidate, preferred) => anchor.select(candidate, preferred),
        ),
      readToolkit,
      subscribe: anchor.subscribe,
    }

    return capabilityPort
  }`,
    ),
    edit(
      raw`    permissionPosture,
    getAgentId: selection.read,
    subscribeAgent: selection.subscribe,
    capabilities,`,
      raw`    permissionPosture,
    capabilities,`,
    ),
    edit(
      raw`      disposed = true
      generation += 1
      stopConfig()
      await pending

      try {`,
      raw`      disposed = true

      try {`,
    ),
    edit(
      raw`/**
 * 这家 agent 报出的第一个可用别名。
 *
 * 已经设过默认模型、或档案没声明清单查询，就没有答案：那一家的模型由它自己的
 * 运行时决定，问不了不是故障。
 */
async function firstUsableModel(
  store: AgentConfigStore,
  agentId: string,
): Promise<string | undefined> {
  const descriptor = requireAgent(agentId)
  const listArgs = descriptor.providerListArgs

  if (listArgs === undefined || (await store.loadDefaultModel(agentId)) !== null) {
    return undefined
  }

  const outcome = await store.execCli({ agentId, args: [...listArgs] })`,
      raw`/** 这家 agent 报出的第一个可用别名。已经设过默认模型就没有答案。 */
async function firstUsableModel(store: AgentConfigStore): Promise<string | undefined> {
  if ((await store.loadDefaultModel(agent.id)) !== null) {
    return undefined
  }

  const outcome = await store.execCli({
    agentId: agent.id,
    args: [...agent.providerListArgs],
  })`,
    ),
    edit(
      raw`  return parseAgentProviderListOutput(outcome.stdout, descriptor.syntheticProviderId)`,
      raw`  return parseAgentProviderListOutput(outcome.stdout, agent.syntheticProviderId)`,
    ),
    editAll(raw`launchSelected`, raw`launchAgent`, 5),
  ],
)

patch(
  'apps/desktop/src/entry/compose-runtime.ts',
  (source) => !source.includes('onSelectionFailure'),
  [
    edit(
      raw`import { failureCoordinator } from '@poietica/problem'
`,
      '',
    ),
    edit(
      raw`import { reportFailure } from '../notice/problem-presentation'
`,
      '',
    ),
    edit(
      raw`    cwd: activeWorkspaceRoot,
    onSelectionFailure: (cause) => {
      reportFailure('AGENT_SELECTION_UNAVAILABLE', {
        scope: 'application-runtime',
        operation: 'load-agent-selection',
        cause,
      })
    },
    onSelectionReady: () => {
      failureCoordinator.resolveOperation('load-agent-selection')
    },
  })`,
      raw`    cwd: activeWorkspaceRoot,
  })`,
    ),
  ],
)

/*
 * 那两段注释本来挂错了目标：它们讲的是「没能读到 agent 给得出哪些选项」与「全新安装」，
 * 也就是下一条 AGENT_CAPABILITIES_UNREADABLE。随着选择这件事消失，把它们接回去。
 */
patch(
  'apps/desktop/src/notice/problem-presentation.ts',
  (source) => !source.includes('AGENT_SELECTION_UNAVAILABLE'),
  [
    edit(
      raw`  'AGENT_SELECTION_UNAVAILABLE',
`,
      '',
    ),
    edit(
      raw`  /*
   * 没能读到 agent 现在给得出哪些选项：模型、模式、推理档位，同一次往返里一起来。
   *
   * 此前这一路只写一条日志：选择器空着，屏幕上没有任何解释 —— 而 agent 的 stderr
   * 恰恰说得出是哪一行配置坏了。一次往返失手不是功能没了，重进这一格就会再问一次，
   * 所以 recovery 是 retry。
   */
  /*
   * 这一条还盖着一个它不该盖的情形：全新安装。
   *
   * 上面那段推理对"偶发失败"成立，对"从来没配过"完全不成立 —— 新电脑上
   * agent CLI 没装、密钥没填，重试一万次结果一样，缺的不是运气，是一个还不
   * 存在的前提。三种处境（没装 / 没配 / 真的失手）现在共用同一个错误码和
   * 同一句话，而前两种根本不是错误，是"还没开始"。
   *
   * 分开它们要新增一个首次运行状态，不是改一句文案能做到的事。在那之前，
   * 这句话至少要把人指向唯一能解决问题的地方 —— 设置页会说出真实的原因：
   * 程序找不到、还是密钥没填。让人对着一句"没能读到"按重试，是最坏的一种。
   */
  AGENT_SELECTION_UNAVAILABLE: {
    impact: 'recoverable',
    userMessage: '无法读取当前 Agent 配置，暂时无法启动 Agent；修正配置后会自动恢复。',
    recovery: 'retry',
    scope: operationScope('load-agent-selection'),
  },

  AGENT_CAPABILITIES_UNREADABLE: {`,
      raw`  /*
   * 没能读到 agent 给得出哪些选项：模型、模式、推理档位，同一次往返里一起来。一次
   * 往返失手不是功能没了，重进这一格会再问一次，所以 recovery 是 retry。
   *
   * 它还盖着「全新安装」：CLI 没装、密钥没填时，重试一万次结果一样。分开要新增一个
   * 首次运行状态，在那之前这句话把人指向设置页 —— 那里说得出到底缺哪一样。
   */
  AGENT_CAPABILITIES_UNREADABLE: {`,
    ),
  ],
)

patch('apps/desktop/src/shell/app-shell.tsx', (source) => !source.includes('subscribeAgent'), [
  edit(
    raw`  /* 现在用哪一家 agent。能力表按它取，见下面那个 effect。 */
  const agentId = useSyncExternalStore(
    runtime.agent.subscribeAgent,
    runtime.agent.getAgentId,
    runtime.agent.getAgentId,
  )

`,
    '',
  ),
  edit(
    raw`   * 端口与重问的通知同源同寿，所以它们是同一个 effect 的一次装载与一次清理。
   *
   * 端口按「用哪一家 agent」建，设置页动过它的配置之后那张表就不再作数。装载几次
   * 就退订几次，不可能配不平 —— 与 ThreadsStore.start 同一条纪律。
   */
  useEffect(() => {
    const stop = agentControls.start(runtime.agent.capabilities(agentId))`,
    raw`   * 端口与重问的通知同源同寿，所以它们是同一个 effect 的一次装载与一次清理。装载
   * 几次就退订几次，不可能配不平 —— 与 ThreadsStore.start 同一条纪律。
   */
  useEffect(() => {
    const stop = agentControls.start(runtime.agent.capabilities())`,
  ),
  edit(
    raw`  }, [agentControls, agentId, runtime.agent, runtime.agentConfig])`,
    raw`  }, [agentControls, runtime.agent, runtime.agentConfig])`,
  ),
])

/* ------------------------------------------------------------------ */
/* 收尾：退场的名字一个都不许剩 */
/* ------------------------------------------------------------------ */

scan('退场的名字还有残留引用：', () => false)

console.log(`refactor: 应用 ${String(applied)} 处，跳过 ${String(skipped)} 处`)
console.log('refactor: 接着跑 bun run check 与 bun test packages/agent-catalog/src')
