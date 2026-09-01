import * as v from 'valibot'
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
  readonly unsetEnv?: readonly string[] | undefined
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
const PROCESS_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MAX_TEXT = 512
const MAX_ENTRIES = 32

const ID_ISSUE = 'agent 标识只允许小写字母、数字与连字符，且以字母开头'
const PROFILE_ISSUE = 'agent 档案无法解析'
const FOREIGN_ISSUE = '配置里有不属于本软件的 agent 档案，已从 agents.json 移除'
const DUPLICATE_ISSUE = '配置里有重复的 agent 档案，只保留了第一条'

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TEXT))
const envName = v.pipe(v.string(), v.regex(ENV_NAME_PATTERN))
const processEnvName = v.pipe(v.string(), v.regex(PROCESS_ENV_NAME_PATTERN))

const ProfileSchema = v.object({
  id: v.pipe(v.string(), v.regex(ID_PATTERN)),
  cwd: v.optional(text),
  env: v.record(envName, text),
  defaultConfigOptions: v.record(text, v.union([text, v.boolean()])),
  command: v.optional(text),
  args: v.optional(v.array(text)),
  unsetEnv: v.optional(v.array(processEnvName)),
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
    Object.keys(profile.defaultConfigOptions).length > MAX_ENTRIES ||
    (profile.unsetEnv?.length ?? 0) > MAX_ENTRIES
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
    unsetEnv: kimiCode.unsetEnv,
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
    sameArgs(profile.unsetEnv, kimiCode.unsetEnv) &&
    profile.homeVar === kimiCode.homeVar &&
    profile.ownHomeDirectory === kimiCode.ownHomeDirectory &&
    sameInstall(profile.install, kimiCode.install)

  return aligned
    ? profile
    : {
        ...profile,
        command: kimiCode.command,
        args: kimiCode.args,
        unsetEnv: kimiCode.unsetEnv,
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
