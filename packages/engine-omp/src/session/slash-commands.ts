import { executeAcpBuiltinSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins'
import {
  type AvailableCommandsSession,
  buildAvailableSlashCommands,
} from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'
import { parseSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse'
import type { SlashCommandRuntime } from '@oh-my-pi/pi-coding-agent/slash-commands/types'
import type { SlashCommand } from '@poietica/engine'

/*
 * 斜杠命令：表与执行都直接用 omp 给宿主的那两个入口（`buildAvailableSlashCommands` /
 * `executeAcpBuiltinSlashCommand`，RPC 与 ACP 宿主用的是同一对），这里只做两件 omp 不替我们做的事：
 *   1. 剔除 GUI 宿主办不了的那几条（见 HOST_BLOCKED）；
 *   2. 把 omp 的条目折成端口的 SlashCommand。
 * 不在这里维护命令清单、不解析命令参数 —— omp 每加一条命令，GUI 不改一行就有。
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
})

type OmpCommandSession = SlashCommandRuntime['session'] & AvailableCommandsSession

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
  const commands = await buildAvailableSlashCommands(session as OmpCommandSession)
  const out: SlashCommand[] = []
  for (const command of commands) {
    /* 技能有自己的入口（输入框的技能标记），这里不再列第二份 */
    if (command.source === 'skill') continue
    if (HOST_BLOCKED[command.name] === null) continue
    const blockedVerbs = HOST_BLOCKED[command.name] ?? []
    out.push({
      name: command.name,
      aliases: [...(command.aliases ?? [])],
      description: command.description ?? null,
      hint: command.input?.hint ?? null,
      source: command.source,
      subcommands: (command.subcommands ?? [])
        .filter((sub) => !blockedVerbs.includes(sub.name))
        .map((sub) => ({ name: sub.name, description: sub.description ?? null })),
    })
  }
  return out
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
