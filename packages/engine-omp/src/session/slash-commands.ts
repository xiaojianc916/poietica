import { loadSlashCommands } from '@oh-my-pi/pi-coding-agent/extensibility/slash-commands'
import { executeAcpBuiltinSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins'
import {
  type AvailableCommandsSession,
  buildAvailableSlashCommands,
} from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'
import { parseSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse'
import type { SlashCommandRuntime } from '@oh-my-pi/pi-coding-agent/slash-commands/types'
import type { SlashCommand } from '@poietica/engine'
import { builtinDescriptionOf, builtinHintOf, builtinRankOf } from './command-text'

/*
 * 斜杠命令：表与执行都直接用 omp 给宿主的那两个入口（`buildAvailableSlashCommands` /
 * `executeAcpBuiltinSlashCommand`，RPC 与 ACP 宿主用的是同一对），这里只做两件 omp 不替我们做的事：
 *   1. 剔除 GUI 宿主办不了的那几条（见 HOST_BLOCKED）；
 *   2. 把 omp 的条目折成端口的 SlashCommand。
 * 不在这里维护命令清单、不解析命令参数 —— omp 每加一条命令，GUI 不改一行就有。
 * 内置命令的中文说明与面板里的先后在 command-text.ts（查不到就是 omp 原文、排在后面）。
 */

/**
 * GUI 宿主不能交给 omp 的命令。值为 null = 整条不进表；数组 = 只拦这几个子命令。理由各不相同：
 * - `move` / `wt`：把会话搬到别的目录。线程绑着工作区，搬走之后线程行与会话文件对不上。
 * - `stats` / `trace`：在 Core 进程里起本地看板服务器并试图开浏览器 —— Core 没有窗口，用量看板由 usage 功能画。
 * - `session delete`：直接删会话文件。删线程走 `threads.delete`，它还要收 SQLite 行与附件引用。
 */
const HOST_BLOCKED: Readonly<Record<string, readonly string[] | null>> = Object.freeze({
  move: null,
  wt: null,
  worktree: null,
  stats: null,
  trace: null,
  session: ['delete'],
  /* omp 恢复列表里的置顶。GUI 的置顶是线程行上的（threads.setPinned），两份置顶各说各的只会让人糊涂。 */
  pin: null,
})

/**
 * 对已有对话才有意义的命令：还没有对话时（入口页）不列。它们处理的是已经说过的话 —— 压缩、重试、重命名、导出……
 * 在一条空对话上跑，只会得到一句「没有可处理的内容」。
 */
const NEEDS_HISTORY: ReadonlySet<string> = new Set([
  'compact',
  'handoff',
  'shake',
  'retry',
  'rename',
  'fresh',
  'export',
  'dump',
  'share',
])

type OmpCommandSession = SlashCommandRuntime['session'] & AvailableCommandsSession

/**
 * 会改写上下文的那两条内置命令：`/compact` 是压缩，`/handoff` 是写一份交接文档再就地压缩。
 * 交回的是 omp 压缩事件里的 action 写法（时间线那一格据此说「正在压缩上下文」还是「正在生成交接文档」），其余命令是 null。
 */
export function compactionActionOf(command: {
  readonly name: string
  readonly source: SlashCommand['source']
}): 'context-full' | 'handoff' | null {
  if (command.source !== 'builtin') return null
  if (command.name === 'compact') return 'context-full'
  if (command.name === 'handoff') return 'handoff'
  return null
}

/** 这句输入点名的是不是一条可执行命令；返回 omp 的条目（含来源），GUI 拦掉的与不认识的都是 null */
export async function resolveSlashCommand(
  session: unknown,
  text: string,
): Promise<{ readonly name: string; readonly source: SlashCommand['source'] } | null> {
  const parsed = parseSlashCommand(text.trim())
  if (parsed === null) return null
  const blocked = HOST_BLOCKED[parsed.name]
  if (blocked === null) return null
  if (blocked !== undefined) {
    const verb = parsed.args.split(/\s+/)[0] ?? ''
    if (blocked.includes(verb)) return null
  }
  const commands = await listSlashCommands(session)
  const hit = commands.find((command) => command.name === parsed.name || command.aliases.includes(parsed.name))
  return hit === undefined ? null : { name: hit.name, source: hit.source }
}

/**
 * 此刻的命令表。`buildAvailableSlashCommands` 顺带把文件命令装进会话（`setSlashCommands`），
 * 所以执行前先走它一遍，prompt 才认得刚放进 `.omp/commands` 的那一条。
 */
export async function listSlashCommands(session: unknown): Promise<readonly SlashCommand[]> {
  const live = session as OmpCommandSession
  /* omp 随包带的那几条（TS 命令 review / green / annotate，文件命令 init）：对人来说就是内置命令，不是「自定义」 */
  const bundled = new Set(
    live.customCommands.filter((loaded) => loaded.source === 'bundled').map((loaded) => loaded.command.name),
  )
  const commands = await buildAvailableSlashCommands(live, (cwd) =>
    loadBundledAware(cwd, live.effectiveExtensionRoots, bundled),
  )
  return foldCommands(commands, bundled)
}

/** 与 omp 的默认读法同一个调用（`loadSlashCommands({ cwd, extensionRoots })`），顺手记下哪几条是随包带的 */
async function loadBundledAware(
  cwd: string,
  extensionRoots: AvailableCommandsSession['effectiveExtensionRoots'],
  bundled: Set<string>,
): Promise<Awaited<ReturnType<typeof loadSlashCommands>>> {
  const files = await loadSlashCommands({ cwd, ...(extensionRoots === undefined ? {} : { extensionRoots }) })
  for (const file of files) {
    if (file.source === 'bundled') bundled.add(file.name)
  }
  return files
}

/**
 * 不开会话的命令表（入口页）：同一个 `buildAvailableSlashCommands`，交给它一份空会话 —— 没有扩展、自定义 TS 命令与
 * MCP 提示词（那些要会话装起来才有），文件命令照 `cwd` 读。再剔掉只对已有对话有意义的那几条（NEEDS_HISTORY）。
 */
export async function listCommandCatalog(cwd: string | null): Promise<readonly SlashCommand[]> {
  const bare: AvailableCommandsSession = {
    customCommands: [],
    skills: [],
    setSlashCommands: () => undefined,
    sessionManager: { getCwd: () => cwd ?? '' },
  }
  const bundled = new Set<string>()
  const commands = await buildAvailableSlashCommands(bare, (dir) =>
    cwd === null ? Promise.resolve([]) : loadBundledAware(dir, undefined, bundled),
  )
  return foldCommands(commands, bundled).filter(
    (command) => command.source !== 'builtin' || !NEEDS_HISTORY.has(command.name),
  )
}

type OmpAvailableCommand = Awaited<ReturnType<typeof buildAvailableSlashCommands>>[number]

/**
 * omp 的条目折成端口的 SlashCommand：剔除技能与 GUI 拦下的命令；随包带的（`bundled`）归为内置 ——
 * 执行不受影响：内置路由认不出它就原样交给 prompt，由 omp 照常展开。内置命令换中文说明、按 command-text 的先后排。
 */
function foldCommands(commands: readonly OmpAvailableCommand[], bundled: ReadonlySet<string>): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const command of commands) {
    /* 技能有自己的入口（输入框的技能标记），这里不再列第二份 */
    if (command.source === 'skill') continue
    if (HOST_BLOCKED[command.name] === null) continue
    out.push(foldCommand(command, bundled.has(command.name) ? 'builtin' : command.source))
  }
  /* 只给内置命令排先后；其余来源保持 omp 的次序（omp 本来就把内置命令排在最前） */
  const builtins = out.filter((command) => command.source === 'builtin')
  builtins.sort((a, b) => builtinRankOf(a.name) - builtinRankOf(b.name))
  return [...builtins, ...out.filter((command) => command.source !== 'builtin')]
}

function foldCommand(command: OmpAvailableCommand, source: SlashCommand['source']): SlashCommand {
  const blockedVerbs = HOST_BLOCKED[command.name] ?? []
  const builtin = source === 'builtin'
  const description = command.description ?? null
  const hint = command.input?.hint ?? null
  return {
    name: command.name,
    aliases: [...(command.aliases ?? [])],
    description: builtin ? builtinDescriptionOf(command.name, description) : description,
    hint: builtin ? builtinHintOf(command.name, hint) : hint,
    source,
    subcommands: (command.subcommands ?? [])
      .filter((sub) => !blockedVerbs.includes(sub.name))
      .map((sub) => ({ name: sub.name, description: sub.description ?? null })),
  }
}

export interface BuiltinCommandHooks {
  readonly signal: AbortSignal
  readonly output: (text: string) => void
  /** 模型 / 档位 / 模式被命令改了：重报控件表 */
  readonly configChanged: () => void
  readonly commandsChanged: () => void
}

/**
 * 跑一条内置命令（omp 的 `executeAcpBuiltinSlashCommand`）。结局三种：`unhandled` = 不是内置命令（交给 prompt）；
 * `local` = 就地办完；`turn` = 命令自己排了一轮 agent（`/retry`）；`prompt` = 办完还剩一段要交给模型的正文。
 */
export async function runBuiltinCommand(
  session: unknown,
  text: string,
  hooks: BuiltinCommandHooks,
): Promise<
  | { readonly kind: 'unhandled' }
  | { readonly kind: 'local' }
  | { readonly kind: 'turn' }
  | { readonly kind: 'prompt'; readonly text: string }
> {
  const live = session as OmpCommandSession
  const runtime: SlashCommandRuntime = {
    session: live,
    sessionManager: live.sessionManager,
    settings: live.settings,
    cwd: live.sessionManager.getCwd(),
    signal: hooks.signal,
    output: (chunk) => hooks.output(chunk),
    refreshCommands: () => hooks.commandsChanged(),
    /* 插件状态归 extensions 功能（它持 plugins.*）；命令改了插件之后，omp 自己的 refreshSkillsAndCommands 足够让本会话看见 */
    reloadPlugins: async () => {
      await live.refreshSkillsAndCommands()
      hooks.commandsChanged()
    },
    /* 会话名变化由 sessionManager.onSessionNameChanged 报（适配器早已订阅），这里不再报第二遍 */
    notifyTitleChanged: () => undefined,
    notifyConfigChanged: () => hooks.configChanged(),
  }
  const result = await executeAcpBuiltinSlashCommand(text.trim(), runtime)
  if (result === false) return { kind: 'unhandled' }
  if ('prompt' in result) return { kind: 'prompt', text: result.prompt }
  return result.agentInvoked === true ? { kind: 'turn' } : { kind: 'local' }
}
