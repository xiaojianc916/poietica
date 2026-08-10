import { assertUnreachable } from '@poietica/core'

import { describeInstallSource } from './install-source'
import type { InstalledPlugin } from './installation'
import type { MarketplaceEntry } from './marketplace'

/*
 * 目录页那几格：分格与状态在这里算完，界面只负责画。
 *
 * 这一份没有 React，也不碰 IPC，所以它在 Node 里单独测得动。
 *
 * 格子照官方 /plugins 面板：Installed / Official / Curated / Custom。官方那一格的判据是
 * 背书等于 kimi-official，其余一律落到「精选」—— 包括没写背书的条目，否则它们两格都不
 * 属于，等于从屏幕上消失。
 */

export type PluginTabId = 'installed' | 'official' | 'curated' | 'custom'

export interface PluginTab {
  readonly id: PluginTabId
  readonly label: string
}

export const PLUGIN_TABS: readonly PluginTab[] = [
  { id: 'installed', label: '已安装' },
  { id: 'official', label: '官方' },
  { id: 'curated', label: '精选' },
  { id: 'custom', label: '手动添加' },
]

/**
 * 一条目录条目在这台机器上是什么状态。
 *
 * elsewhere 是「命令行那本账里有」。它不是「装了」：受控 home 生效时，我们开出去的会话
 * 只装载受控 home 那本账，所以那一行仍然可装。
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
 * 状态那一列的字。
 *
 * 两个版本号都在时只并列，不判新旧：谁新谁旧要按 semver 的规则算（预发布、构建元数据），
 * 一句字符串比较必然出错。原生侧已经有 semver 那个 crate，这件事将来交给它，不在这一层
 * 现编一个。
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

      return `${here} · 目录里是 v${status.catalogVersion}`
    }
    default:
      return assertUnreachable(status)
  }
}

/**
 * 只有命令行装得了的那两台官方能力。
 *
 * 它们不在市场目录里 —— 目录（code.kimi.com/kimi-code/plugins/marketplace.json）官方那一
 * 栏只有 kimi-datasource 一条。官方面板上多出来的两行是引擎自己报的能力表，由
 * capabilityService 的 listCapabilities / installCapability 提供，走 kimi-code 自己那条
 * RPC 的全局通道（packages/klient/src/contract/global/capabilities.ts 里那份契约，id 是一
 * 个只有两个取值的枚举），而且只有 v2 引擎有这个域。
 *
 * 本应用与 CLI 说的是 ACP。ACP 的方法表里没有能力这一族，官方文档写明「上述未列出的方法
 * 一律返回 methodNotFound」（docs/zh/reference/kimi-acp.md），所以这条连接问不到也装不了。
 * 列出来但不给安装按钮：不列，人会以为自己看漏了；给一个点下去必然失败的按钮，比不列更糟。
 */
export interface CapabilityPromo {
  readonly id: 'kimi-cu' | 'kimi-webbridge'
  readonly displayName: string
  readonly description: string
  /** 官方说明页。没有可引用的地址时缺席 —— 这一层不编 URL。 */
  readonly homepage: string | undefined
}

export const CAPABILITY_PROMOS: readonly CapabilityPromo[] = [
  {
    id: 'kimi-cu',
    displayName: 'Kimi Computer Use',
    description: '读桌面应用的界面并代你点击、输入、滚动、拖拽。Windows 专有。',
    homepage: undefined,
  },
  {
    id: 'kimi-webbridge',
    displayName: 'Kimi WebBridge',
    description: '接管你自己那个已经登录的浏览器：导航、点击、输入、读页面、截图。',
    homepage: 'https://www.kimi.com/features/webbridge#local-agent',
  },
]

export interface CatalogRow {
  readonly kind: 'catalog'
  readonly entry: MarketplaceEntry
  readonly status: ListingStatus
}

export interface PromoRow {
  readonly kind: 'promo'
  readonly promo: CapabilityPromo
}

export type ListingRow = CatalogRow | PromoRow

export interface ListingInput {
  readonly entries: readonly MarketplaceEntry[]
  readonly installed: readonly InstalledPlugin[]
  /** 命令行那本账里出现过的插件号。 */
  readonly elsewhereIds: ReadonlySet<string>
  readonly needle: string
}

export interface Listing {
  readonly official: readonly ListingRow[]
  readonly curated: readonly ListingRow[]
}

export interface TabCounts {
  readonly installed: number
  readonly available: number
}

/*
 * 判空交给标准库：Array.prototype.join 规定 undefined 与 null 元素渲染成空串
 * （ECMA-262 23.1.3.18），所以逐个字段判一遍是在手搓一件已经被解决的事。
 * 分隔符取换行而不是空串，免得相邻两个字段的拼接处凑出一个本不存在的匹配。
 */
export function matches(needle: string, ...fields: readonly (string | undefined)[]): boolean {
  return needle === '' || fields.join('\n').toLowerCase().includes(needle.toLowerCase())
}

export function buildListing(input: ListingInput): Listing {
  /*
   * 「这一条装了没有」比的是来源的描述串，与背书用的是同一条判据（见 plugin-store 里
   * 那个 listing）：目录条目里的来源和账本里记下的那一串是两个结构相同、引用不同的东西，
   * 用 === 比永远不等。插件号不能当判据 —— 账本的键是清单里的 name，目录的键是市场号，
   * 两者没有任何一处保证它们相同。
   */
  const here = new Map<string, InstalledPlugin>()

  for (const plugin of input.installed) {
    const { source } = plugin

    if (source !== undefined) {
      here.set(describeInstallSource(source), plugin)
    }
  }

  const rows = input.entries
    .filter((entry) => matches(input.needle, entry.displayName, entry.id, entry.description))
    .map(
      (entry): CatalogRow => ({
        kind: 'catalog',
        entry,
        status: statusOf(entry, here, input.elsewhereIds),
      }),
    )

  const promos = CAPABILITY_PROMOS.filter((promo) =>
    matches(input.needle, promo.displayName, promo.id, promo.description),
  ).map((promo): PromoRow => ({ kind: 'promo', promo }))

  return {
    official: [...ordered(rows.filter((row) => row.entry.trust === 'kimi-official')), ...promos],
    curated: ordered(rows.filter((row) => row.entry.trust !== 'kimi-official')),
  }
}

/** 底下那一行数字。只数目录条目：装不了的那两行不该被算进「可装」。 */
export function countRows(rows: readonly ListingRow[]): TabCounts {
  const catalog = rows.filter((row): row is CatalogRow => row.kind === 'catalog')

  return {
    installed: catalog.filter((row) => row.status.kind === 'installed').length,
    available: catalog.filter((row) => row.status.kind !== 'installed').length,
  }
}

/*
 * 装过的排最前。
 *
 * 用 sort 而不是 toSorted：后者要 ES2023 的 lib，而这件事不值得为它抬一档；
 * Array.prototype.sort 自 ES2019 起规范要求稳定，同状态的条目因此保持目录里的次序。
 */
function ordered(rows: readonly CatalogRow[]): readonly CatalogRow[] {
  return [...rows].sort((left, right) => rank(left) - rank(right))
}

function rank(row: CatalogRow): number {
  return row.status.kind === 'installed' ? 0 : 1
}

function statusOf(
  entry: MarketplaceEntry,
  here: ReadonlyMap<string, InstalledPlugin>,
  elsewhereIds: ReadonlySet<string>,
): ListingStatus {
  const installed = here.get(describeInstallSource(entry.source))

  if (installed !== undefined) {
    return {
      kind: 'installed',
      installedVersion: installed.manifest.version,
      catalogVersion: entry.version,
    }
  }

  return elsewhereIds.has(entry.id) ? { kind: 'elsewhere' } : { kind: 'installable' }
}
