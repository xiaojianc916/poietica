import { assertUnreachable } from '@poietica/core'
import * as v from 'valibot'
import {
  type PluginInstallSource,
  type PluginTrustTier,
  parseInstallSource,
  UNLISTED_TRUST,
} from './install-source'

/*
 * 上游那一列叫 tier，值是 official / curated；这个仓库内部用的是三档 trust。
 * 两套词汇在解码这一层就合并成一套，否则「上游怎么说」和「我们怎么判」会各自长大。
 *
 * 认不出的 tier 不拒收整份目录，只落到第三方：一个没见过的档位意味着没有背书，
 * 而没有背书恰好就是第三方的定义。为一个新档位把整份目录判死是不成比例的。
 */
const TIER_TRUST: Readonly<Record<string, PluginTrustTier>> = {
  official: 'kimi-official',
  curated: 'curated',
}

const RELATIVE_SOURCE = /^\.\.?\//

/*
 * 目录里的相对来源，相对的是目录文件自己那个地址。
 *
 * 解析交给 URL 构造器的第二个参数，也就是 WHATWG URL Standard 里 new URL(input, base)
 * 那条 base-relative 解析（底下是 RFC 3986 §5），与上游
 * apps/kimi-code/src/utils/plugin-marketplace.ts 解条目来源时用的是同一句。
 *
 * 手写「拆四段、拼路径、挡 ..」是在重做一件标准库已经做完的事，而它挡住的东西目录
 * 本来就能用绝对地址直接写出来 —— 挡的是自己，不是攻击者。真正拦第三方来源的那道门
 * 是 requiresInstallConfirmation，不在这里。
 *
 * 解不开就按字面交给唯一的解析器：一串解不成地址的相对路径，字面意思本来就是路径。
 */
function resolveEntrySource(specifier: string, catalogUrl: string): PluginInstallSource {
  if (!RELATIVE_SOURCE.test(specifier)) {
    return parseInstallSource(specifier)
  }

  try {
    return parseInstallSource(new URL(specifier, catalogUrl).toString())
  } catch {
    return parseInstallSource(specifier)
  }
}

export interface MarketplaceEntry {
  readonly id: string
  readonly displayName: string
  readonly description: string | undefined
  readonly homepage: string | undefined
  readonly version: string | undefined
  /** 目录自带的分类词。卡片分组读它，不另立一张我们自己的分类表。 */
  readonly keywords: readonly string[]
  readonly source: PluginInstallSource
  readonly trust: PluginTrustTier
}

export interface MarketplaceCatalog {
  readonly entries: readonly MarketplaceEntry[]
}

/*
 * 每一格都接受上游接受的那两个名字（apps/kimi-code/src/utils/plugin-marketplace.ts 的
 * parseMarketplaceEntry：source|url|downloadUrl、displayName|name、
 * description|shortDescription、homepage|websiteURL）。
 *
 * 只认一个名字，官方目录里用另一个名字写的条目会安静地少掉半格 —— 少掉来源的那一条
 * 直接装不上，而界面上它看起来与别的条目没有任何区别。
 */
const RawEntry = v.looseObject({
  id: v.string(),
  displayName: v.optional(v.string()),
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  shortDescription: v.optional(v.string()),
  homepage: v.optional(v.string()),
  websiteURL: v.optional(v.string()),
  version: v.optional(v.string()),
  keywords: v.optional(v.array(v.string())),
  tier: v.optional(v.string()),
  source: v.optional(v.string()),
  url: v.optional(v.string()),
  downloadUrl: v.optional(v.string()),
})

/*
 * version 读进来，不比较。
 *
 * 上游 parsePluginMarketplace 对这一格只做 stringField，全程没有任何比较：目录格式的
 * 版本号是发布方自己的记事，不是消费方的准入条件。写死一个数字去比，等于官方哪天把它
 * 从一个字符串改成另一个，我们这边整页空白，而目录的形状一个字节都没变。
 */
const RawCatalog = v.looseObject({
  version: v.optional(v.string()),
  plugins: v.array(RawEntry),
})

export interface DecodedCatalog {
  readonly kind: 'decoded'
  readonly catalog: MarketplaceCatalog
}

export interface UndecodableCatalog {
  readonly kind: 'undecodable'
  readonly reason: string
}

export type CatalogDecoding = DecodedCatalog | UndecodableCatalog

/*
 * 目录里的 source 在解码当场就变成结构，不以字符串的形态往下传：字符串会被
 * 沿途每一处各自解释一遍，而解释不一致时没有任何东西会报错。
 */
export function decodeMarketplaceCatalog(raw: unknown, catalogUrl: string): CatalogDecoding {
  const parsed = v.safeParse(RawCatalog, raw)

  if (!parsed.success) {
    return { kind: 'undecodable', reason: parsed.issues.map((issue) => issue.message).join('; ') }
  }

  const entries: MarketplaceEntry[] = []

  for (const entry of parsed.output.plugins) {
    const specifier = entry.source ?? entry.url ?? entry.downloadUrl

    /*
     * 一条没有来源的条目不是「一条装不上的条目」，是这份目录不成形。丢掉它，界面上
     * 少一张卡片而没有任何人知道少了哪一张；整份拒收会带着 id 说出来。
     */
    if (specifier === undefined) {
      return { kind: 'undecodable', reason: `目录条目 ${entry.id} 没有说从哪里取` }
    }

    entries.push({
      id: entry.id,
      displayName: entry.displayName ?? entry.name ?? entry.id,
      description: entry.description ?? entry.shortDescription,
      homepage: entry.homepage ?? entry.websiteURL,
      version: entry.version,
      keywords: entry.keywords ?? [],
      source: resolveEntrySource(specifier, catalogUrl),
      trust: (entry.tier === undefined ? undefined : TIER_TRUST[entry.tier]) ?? UNLISTED_TRUST,
    })
  }

  return { kind: 'decoded', catalog: { entries } }
}

export interface AbsentCatalog {
  readonly kind: 'absent'
}

export interface FetchingCatalog {
  readonly kind: 'fetching'
  readonly previous: MarketplaceCatalog | undefined
}

export interface ReadyCatalog {
  readonly kind: 'ready'
  readonly catalog: MarketplaceCatalog
}

export interface FailedCatalog {
  readonly kind: 'failed'
  readonly previous: MarketplaceCatalog | undefined
  readonly reason: string
}

/*
 * 目录的四种状态。
 *
 * fetching 与 failed 都带着上一份：刷新失败时界面继续显示旧目录，而不是把人
 * 已经看着的东西清空 —— 清空是在惩罚用户，不是在报告事实。三个平行字段
 * （catalog / isRefreshing / error）写不出这条保证，只能靠人记得别清。
 */
export type MarketplaceState = AbsentCatalog | FailedCatalog | FetchingCatalog | ReadyCatalog

export const MARKETPLACE_ABSENT: MarketplaceState = { kind: 'absent' }

export function latestCatalog(state: MarketplaceState): MarketplaceCatalog | undefined {
  switch (state.kind) {
    case 'absent':
      return undefined
    case 'failed':
      return state.previous
    case 'fetching':
      return state.previous
    case 'ready':
      return state.catalog
    default:
      return assertUnreachable(state)
  }
}

/*
 * 只有从来没取过才自动拉一次。取回来之后落盘，之后每次打开读的都是那一份；
 * 再要新的是人按刷新。这条判据只有这一个地方说了算。
 */
export function shouldFetchOnOpen(state: MarketplaceState): boolean {
  return state.kind === 'absent'
}

export function beginFetch(state: MarketplaceState): MarketplaceState {
  return { kind: 'fetching', previous: latestCatalog(state) }
}

export function completeFetch(
  state: MarketplaceState,
  raw: unknown,
  catalogUrl: string,
): MarketplaceState {
  const decoded = decodeMarketplaceCatalog(raw, catalogUrl)

  if (decoded.kind === 'undecodable') {
    return { kind: 'failed', previous: latestCatalog(state), reason: decoded.reason }
  }

  return { kind: 'ready', catalog: decoded.catalog }
}

export function failFetch(state: MarketplaceState, reason: string): MarketplaceState {
  return { kind: 'failed', previous: latestCatalog(state), reason }
}
