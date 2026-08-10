import type { ToolCallTimelineItem } from '@poietica/agent'

/**
 * 上游没报类别时，从入参的形状把它认回来。
 *
 * 只在 kind 为 other 时开口 —— other 是协议里「我没说」那一档，填它不与任何人矛盾；
 * 上游已经报了别的档，那是它交出来的事实，这一层不改写。
 *
 * 判据只认形状，不认工具名 —— 我们这一侧根本收不到工具名：ACP 的 tool_call 里只有
 * title / kind / rawInput 三样，而 title 是 description ?? name，抓取类调用交出来的是
 * 那条地址，名字在路上就没了。所以「把某个工具名映射成某一档」这种改法在客户端无从
 * 落笔，能问的只有入参。
 *
 * 这张表与 tool-intent.ts 的 KEYS 是同一类约定 —— 某一家 agent 的入参习惯，不是协议的
 * 一部分。接第二家 agent 时它们一起搬进 AgentDialect。
 *
 * 表里只有一条，因为今天只有一条无歧义：一个 http(s) 地址就是要去取它。路径三键不在
 * 表里 —— 入参里有 file_path 只说明它碰过某个文件，读还是写看不出来，把写认成读比戴
 * 一枚扳手更糟。
 *
 * 现实中的触发者：kimi-code 的抓取工具注册名是 FetchURL，而它 ACP 侧那张表匹配的是旧
 * 名 WebFetch（packages/acp-server/src/events-map.ts 的 inferToolKind），于是这一档漏成
 * other。那是上游的一行错，但客户端不该因为别人漏填就把地球仪一起丢掉。
 *
 * stringOf 与 tool-intent.ts 里那份逐字相同。第三处出现之前，一个名字的成本高于一份
 * 重复 —— 何况那一层的规矩是「只转述不判断」，这一层做的正是判断，共用一个导出反而
 * 会把两条相反的规矩绑在一起。
 */

const HTTP = /^https?:\/\//

/** 入参里的一格，只认非空字符串。 */
function stringOf(bag: unknown, key: string): string | null {
  if (typeof bag !== 'object' || bag === null) {
    return null
  }

  const value: unknown = Reflect.get(bag, key)

  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 这次调用算哪一档。上游报了就用上游的，只有 other 才问入参。 */
export function readToolKind(
  item: Pick<ToolCallTimelineItem, 'kind' | 'rawInput'>,
): ToolCallTimelineItem['kind'] {
  if (item.kind !== 'other') {
    return item.kind
  }

  const url = stringOf(item.rawInput, 'url')

  return url !== null && HTTP.test(url) ? 'fetch' : item.kind
}
