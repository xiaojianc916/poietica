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
