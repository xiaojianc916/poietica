import { type PluginCommand, resolveCommands } from './command'
import type { PluginDiagnostic, PluginManifest } from './manifest'
import { MARKDOWN_SUFFIX, type MarkdownFile } from './markdown'
import { type PluginSkill, resolveSkills } from './skill'

/*
 * 清单说的是「到哪里去找」，路径下那些 Markdown 才是技能与命令本身。这一层把两者合起
 * 来，交出「这个插件真的带来了什么」。
 *
 * 读盘不在这里发生：树读取器由持有 IPC 的那一层注入，所以这条判定在 Node 里可以脱离
 * 进程与界面单独测。同理「哪个后缀算数」由这一层给出 —— 原生侧不认识技能，也不认识
 * 命令，它只会按后缀过滤。
 */

/** 一条声明路径下的 Markdown。路径不在盘上时交回 null —— 那是一条诊断，不是空目录。 */
export type PluginTreeReader = (
  root: string,
  suffix: string,
) => Promise<readonly MarkdownFile[] | null>

export interface PluginRegistry {
  readonly skills: readonly PluginSkill[]
  readonly commands: readonly PluginCommand[]
  readonly diagnostics: readonly PluginDiagnostic[]
}

export const EMPTY_REGISTRY: PluginRegistry = { skills: [], commands: [], diagnostics: [] }

export async function readRegistry(
  pluginId: string,
  manifest: PluginManifest,
  read: PluginTreeReader,
): Promise<PluginRegistry> {
  const skills: PluginSkill[] = []
  const commands: PluginCommand[] = []
  const diagnostics: PluginDiagnostic[] = []
  const skillNames = new Set<string>()
  const commandNames = new Set<string>()

  for (const declared of manifest.skillRoots) {
    const files = await read(declared, MARKDOWN_SUFFIX)

    if (files === null) {
      diagnostics.push(absent(pluginId, declared))
      continue
    }

    const resolved = resolveSkills(pluginId, declared, files)

    diagnostics.push(...resolved.diagnostics)

    for (const skill of resolved.skills) {
      /* 单个声明根里的同名由 resolveSkills 判掉，跨根撞名只有这里看得见。 */
      if (skillNames.has(skill.name.toLowerCase())) {
        diagnostics.push({
          code: 'name-taken',
          pluginId,
          detail: `技能名 "${skill.name}" 出现了不止一次，${skill.path} 没有生效`,
        })
        continue
      }

      skillNames.add(skill.name.toLowerCase())
      skills.push(skill)
    }
  }

  for (const declared of manifest.commandRoots) {
    const files = await read(declared, MARKDOWN_SUFFIX)

    if (files === null) {
      diagnostics.push(absent(pluginId, declared))
      continue
    }

    const resolved = resolveCommands(pluginId, files)

    diagnostics.push(...resolved.diagnostics)

    for (const command of resolved.commands) {
      if (commandNames.has(command.name.toLowerCase())) {
        diagnostics.push({
          code: 'name-taken',
          pluginId,
          detail: `命令名 "${command.name}" 出现了不止一次，${command.path} 没有生效`,
        })
        continue
      }

      commandNames.add(command.name.toLowerCase())
      commands.push(command)
    }
  }

  return { skills, commands, diagnostics }
}

/*
 * 声明了却不在盘上是常事（发布时漏打包一个目录），所以它是一条诊断而不是一次失败：
 * 一个插件写错路径不该让另外几个插件的扫描一起没有结果。
 */
function absent(pluginId: string, declared: string): PluginDiagnostic {
  return {
    code: 'path-missing',
    pluginId,
    detail: `清单声明的 ${declared} 不在这个插件里，本次加载没有从它读到任何东西`,
  }
}
