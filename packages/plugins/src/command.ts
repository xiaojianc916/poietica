import type { PluginDiagnostic } from './manifest'
import { MARKDOWN_SUFFIX, type MarkdownFile, parseFrontmatter, stringField } from './markdown'

/*
 * 命令是目录里的 Markdown 文件，一份文件一条命令，名字就是文件名去掉 .md。清单里的
 * commands 是路径不是定义 —— vercel-plugin 写的是 ["./commands"]，那是一条路径。
 */

export interface PluginCommand {
  readonly pluginId: string
  readonly name: string
  readonly description: string | undefined
  /* 命名空间是插件名，所以两个插件各有一条 deploy 并不冲突。 */
  readonly invocation: string
  /* 正文里有没有 $ARGUMENTS —— 有的话界面要提示这条命令收参数。 */
  readonly acceptsArguments: boolean
  readonly path: string
}

export interface ResolvedCommands {
  readonly commands: readonly PluginCommand[]
  readonly diagnostics: readonly PluginDiagnostic[]
}

export function resolveCommands(
  pluginId: string,
  files: readonly MarkdownFile[],
): ResolvedCommands {
  const commands: PluginCommand[] = []
  const diagnostics: PluginDiagnostic[] = []
  const taken = new Set<string>()

  for (const file of files) {
    const leaf = file.path.split('/').at(-1) ?? ''

    if (!leaf.endsWith(MARKDOWN_SUFFIX)) {
      continue
    }

    const document = parseFrontmatter(file.contents)

    if (document.kind === 'malformed') {
      diagnostics.push({
        code: 'frontmatter-invalid',
        pluginId,
        detail: `${file.path} 的 frontmatter 读不出来：${document.reason}`,
      })
      continue
    }

    const name = leaf.slice(0, -MARKDOWN_SUFFIX.length)
    const key = name.toLowerCase()

    if (taken.has(key)) {
      diagnostics.push({
        code: 'name-taken',
        pluginId,
        detail: `命令名 "${name}" 出现了不止一次，${file.path} 没有生效`,
      })
      continue
    }

    taken.add(key)
    commands.push({
      pluginId,
      name,
      description: stringField(document.kind === 'parsed' ? document.data : {}, 'description'),
      invocation: `/${pluginId}:${name}`,
      acceptsArguments: document.body.includes('$ARGUMENTS'),
      path: file.path,
    })
  }

  return { commands, diagnostics }
}
