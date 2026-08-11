import { assertUnreachable } from '@poietica/core'

import { describeInstallSource, type PluginInstallSource } from '../install-source'
import type { InstalledPlugin } from '../installation'
import type { MarketplaceEntry } from '../marketplace'
import type { ResolvedMcpServer } from '../mcp-servers'
import { BUILTIN_SERVERS } from './builtin'
import type { CatalogChannel } from './scope'

/*
 * 名单页那些格子：分组与状态在这里算完，界面只负责画。没有 React、不碰 IPC，所以它在
 * Node 里单独测得动。
 *
 * 分组读名单自己带的分类词（目录条目的 keywords、内置条目的 group），不另立一张我们自己
 * 的分类表 —— 第二张表迟早与第一张漂开，而漂开时没有任何东西会报错。
 */

export type ListingStatus =
  | { readonly kind: 'installable' }
  | { readonly kind: 'elsewhere' }
  | {
      readonly kind: 'installed'
      readonly installedVersion: string | undefined
      readonly catalogVersion: string | undefined
    }

/*
 * 两个版本号都在时只并列，不判新旧：谁新谁旧要按 semver 的规则算（预发布、构建元数据），
 * 一句字符串比较必然出错。
 */
export function statusText(status: ListingStatus): string {
  switch (status.kind) {
    case 'installable':
      return '可安装'
    case 'elsewhere':
      return '命令行里装过'
    case 'installed': {
      const here =
        status.installedVersion === undefined ? '已安装' : `已安装 · v${status.installedVersion}`

      if (
        status.catalogVersion === undefined ||
        status.catalogVersion === status.installedVersion
      ) {
        return here
      }

      return `${here} · 名单里是 v${status.catalogVersion}`
    }
    default:
      return assertUnreachable(status)
  }
}

export interface CatalogRow {
  readonly key: string
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly channel: CatalogChannel
  readonly group: string
  readonly status: ListingStatus
  /** 装它要走哪条路。内置 MCP 名单不是插件，缺席。 */
  readonly source: PluginInstallSource | undefined
}

export interface RowGroup {
  readonly title: string
  readonly rows: readonly CatalogRow[]
}

/*
 * 判空交给标准库：Array.prototype.join 规定 undefined 与 null 元素渲染成空串，逐个字段
 * 判一遍是在手搓一件已被解决的事。分隔符取换行而不是空串，免得相邻两段拼接处凑出一个
 * 本不存在的匹配。
 */
export function matches(needle: string, ...fields: readonly (string | undefined)[]): boolean {
  return needle === '' || fields.join('\n').toLowerCase().includes(needle.toLowerCase())
}

/* 已装的排最前。sort 自 ES2019 起规范要求稳定，同状态因此保持名单里的次序。 */
function ordered(rows: readonly CatalogRow[]): readonly CatalogRow[] {
  return [...rows].sort((left, right) => rank(left) - rank(right))
}

function rank(row: CatalogRow): number {
  return row.status.kind === 'installed' ? 0 : 1
}

/*
 * 「精选」永远在最前，其余按名字排 —— 组名是远端给的开放集合，写死一张全序表意味着
 * 上游加一个组我们这边就少一格。
 */
const FEATURED = '精选'

export function groupRows(rows: readonly CatalogRow[]): readonly RowGroup[] {
  const buckets = new Map<string, CatalogRow[]>()

  for (const row of rows) {
    const bucket = buckets.get(row.group)

    if (bucket === undefined) {
      buckets.set(row.group, [row])
      continue
    }

    bucket.push(row)
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0
      if (left === FEATURED) return -1
      if (right === FEATURED) return 1

      return left.localeCompare(right)
    })
    .map(([title, bucket]) => ({ title, rows: ordered(bucket) }))
}

export interface PluginListingInput {
  readonly entries: readonly MarketplaceEntry[]
  readonly installed: readonly InstalledPlugin[]
  /** 命令行那本账里出现过的插件号。 */
  readonly elsewhereIds: ReadonlySet<string>
  readonly needle: string
}

/*
 * 目录条目的行。
 *
 * 「这一条装了没有」比的是来源的描述串：目录里的来源和账本里记下的那一串是两个结构相同、
 * 引用不同的东西，用 === 比永远不等。插件号不能当判据 —— 账本的键是清单里的 name，目录
 * 的键是市场号，两者没有任何一处保证相同。
 */
export function publicPluginRows(input: PluginListingInput): readonly CatalogRow[] {
  const here = new Map<string, InstalledPlugin>()

  for (const plugin of input.installed) {
    const { source } = plugin

    if (source !== undefined) {
      here.set(describeInstallSource(source), plugin)
    }
  }

  return input.entries
    .filter((entry) => matches(input.needle, entry.displayName, entry.id, entry.description))
    .map((entry): CatalogRow => {
      const installed = here.get(describeInstallSource(entry.source))

      const status: ListingStatus =
        installed === undefined
          ? input.elsewhereIds.has(entry.id)
            ? { kind: 'elsewhere' }
            : { kind: 'installable' }
          : {
              kind: 'installed',
              installedVersion: installed.manifest.version,
              catalogVersion: entry.version,
            }

      return {
        key: `kimi/${entry.id}`,
        id: entry.id,
        displayName: entry.displayName,
        description: entry.description ?? describeInstallSource(entry.source),
        channel: 'kimi',
        group: entry.keywords[0] ?? '其他',
        status,
        source: entry.source,
      }
    })
}

/*
 * 个人那一档：装在这里、但名单上查不到来源的那些。
 *
 * 它们是用户自己指路径或直链装进来的，没有任何名单为它们背书，卸载之后也没有任何名单能
 * 把卡片留住 —— 所以这一档的卡片就该跟着消失，这条由 scopeOf 说了算。
 */
export function personalPluginRows(
  installed: readonly InstalledPlugin[],
  needle: string,
): readonly CatalogRow[] {
  return installed
    .filter((plugin) => plugin.source === undefined)
    .filter((plugin) =>
      matches(needle, plugin.manifest.displayName, plugin.pluginId, plugin.manifest.description),
    )
    .map(
      (plugin): CatalogRow => ({
        key: `personal/${plugin.pluginId}`,
        id: plugin.pluginId,
        displayName: plugin.manifest.displayName,
        description: plugin.manifest.description ?? '这个插件没有写说明。',
        channel: 'personal',
        group: '手动添加',
        status: {
          kind: 'installed',
          installedVersion: plugin.manifest.version,
          catalogVersion: undefined,
        },
        source: undefined,
      }),
    )
}

/*
 * 内置那份名单的行。
 *
 * 「已装」的判据是这台服务器的名字出现在已解析的那张 MCP 表里 —— 那张表是唯一真相，这里
 * 只拿名字去对，不另存一份「我们装过什么」。
 */
export function builtinServerRows(
  resolved: readonly ResolvedMcpServer[],
  needle: string,
): readonly CatalogRow[] {
  const present = new Set(resolved.map((server) => server.name))

  return BUILTIN_SERVERS.filter((server) =>
    matches(needle, server.displayName, server.id, server.description),
  ).map(
    (server): CatalogRow => ({
      key: `builtin/${server.id}`,
      id: server.id,
      displayName: server.displayName,
      description: server.description,
      channel: 'builtin',
      group: server.group,
      status: present.has(server.id)
        ? { kind: 'installed', installedVersion: undefined, catalogVersion: undefined }
        : { kind: 'installable' },
      source: undefined,
    }),
  )
}
