import * as v from 'valibot'

import type { ContributionOrigin } from './origin'

/*
 * mcp.json 这份文档，拆成一台台服务器。
 *
 * 形状由 Kimi 官方文档给定：{ "mcpServers": { "<名字>": { …一台的配置… } } }，
 * 用户级与项目级同一份形状，插件清单里那一格也是同一份形状。所以文档拆解只有这一处。
 *
 * 一台服务器自己的配置不往下传：起它的是 CLI，本应用只需要名字和那个 enabled。把配置
 * 搬进领域层就会有人去解它，而解出来的那份必然比 CLI 认的少几个字段。
 *
 * 收的是已经 parse 过的 JSON 而不是字符串：谁读的文件谁负责报告读不出来。读文件这件
 * 事不属于这一层，把它塞进来只会让这个纯函数变得要么能抛异常、要么要吞掉异常。
 */

export interface DeclaredMcpServer {
  readonly name: string
  readonly origin: ContributionOrigin
  /**
   * 配置文件里那个 enabled 字段。官方文档：Set to false to disable this server，
   * 缺省为真。它和人在界面上拨的那个开关不是一回事 —— 后者是本应用自己的偏好。
   */
  readonly enabledInConfig: boolean
}

export interface McpConfigDecoding {
  readonly servers: readonly DeclaredMcpServer[]
  /** 文档在，但不是这个形状。空文档与坏文档不能混为一谈。 */
  readonly malformed: boolean
}

const ServerEntry = v.looseObject({ enabled: v.optional(v.boolean()) })

const McpConfigDocument = v.looseObject({
  mcpServers: v.optional(v.record(v.string(), ServerEntry)),
})

export function decodeMcpConfig(origin: ContributionOrigin, document: unknown): McpConfigDecoding {
  /*
   * 数组要先挡掉。
   *
   * typeof [] === 'object' 是语言事实，looseObject 于是照收：["nope"] 会被当成一份
   * 没有 mcpServers 的合法空文档，坏文档就此伪装成空文档 —— 界面上一句话都不会说，
   * 人只会以为自己没配。判法用 Array.isArray：跨 realm 时 instanceof Array 会失手。
   */
  if (Array.isArray(document)) {
    return { servers: [], malformed: true }
  }

  const parsed = v.safeParse(McpConfigDocument, document)

  if (!parsed.success) {
    return { servers: [], malformed: true }
  }

  const servers = Object.entries(parsed.output.mcpServers ?? {}).map(([name, entry]) => ({
    name,
    origin,
    enabledInConfig: entry.enabled !== false,
  }))

  return { servers, malformed: false }
}

/*
 * 写回侧：同一份形状的三种改法，与解码住同一个文件 —— mcpServers 的解释全仓只有这
 * 一处。三个函数都收正文、交正文，不碰磁盘：读、比对、落盘归原生侧那条写入命令，
 * 队列与失败处理归 plugin-store，这里只算内容。
 *
 * 用 JSON.parse/JSON.stringify 原样携带：条目里 CLI 认得而这里不认识的字段
 * （command、args、cwd、headers…）原封不动。缩进两格，与官方示例同形。
 */

interface EditableMcpConfig {
  readonly mcpServers?: Record<string, Record<string, unknown>>
  readonly [key: string]: unknown
}

function parseForEdit(contents: string | null): EditableMcpConfig {
  if (contents === null || contents.trim() === '') {
    return {}
  }

  const parsed: unknown = JSON.parse(contents)

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mcp.json 的顶层不是一个 JSON 对象，不改它')
  }

  return parsed as EditableMcpConfig
}

function editServers(
  contents: string | null,
  edit: (servers: Record<string, Record<string, unknown>>) => void,
): string {
  const document = parseForEdit(contents)
  const servers: Record<string, Record<string, unknown>> = { ...(document.mcpServers ?? {}) }

  edit(servers)

  return `${JSON.stringify({ ...document, mcpServers: servers }, null, 2)}\n`
}

/** 读出一台条目的正文；文件缺席、不是合法 JSON 或没这台时给 undefined。 */
export function mcpServerBodyInConfig(
  contents: string | null,
  name: string,
): Record<string, unknown> | undefined {
  try {
    const body: unknown = parseForEdit(contents).mcpServers?.[name]

    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 装上（或换掉）一台：条目正文整个来自调用方，别的条目一个字节不动。 */
export function upsertMcpServer(
  contents: string | null,
  name: string,
  body: Record<string, unknown>,
): string {
  return editServers(contents, (servers) => {
    servers[name] = body
  })
}

/** 卸掉一台。本来就没有时照样交回整份 —— 卸载是幂等的。 */
export function removeMcpServer(contents: string | null, name: string): string {
  return editServers(contents, (servers) => {
    delete servers[name]
  })
}

/**
 * 拨一台的开关。开 = 抹掉 enabled 那一格（官方语义缺席即开），关 = enabled: false ——
 * 与 CLI 读的是同一格，所以两边看到的永远是同一个答案。
 */
export function setMcpServerEnabledInConfig(
  contents: string | null,
  name: string,
  enabled: boolean,
): string {
  return editServers(contents, (servers) => {
    const entry = servers[name]

    if (entry === undefined) {
      throw new Error(`mcp.json 里没有 ${name} 这一台，拨不了它的开关`)
    }

    if (enabled) {
      const { enabled: _gone, ...rest } = entry

      servers[name] = rest

      return
    }

    servers[name] = { ...entry, enabled: false }
  })
}
