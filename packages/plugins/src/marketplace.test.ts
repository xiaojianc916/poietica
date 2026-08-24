import { describe, expect, it } from 'bun:test'
import { parseInstallSource } from './install-source'
import {
  beginFetch,
  completeFetch,
  decodeMarketplaceCatalog,
  failFetch,
  latestCatalog,
  MARKETPLACE_ABSENT,
  shouldFetchOnOpen,
} from './marketplace'

/*
 * 官方那一个地址：上游 apps/kimi-code/src/constant/app.ts 的
 * KIMI_CODE_PLUGIN_MARKETPLACE_URL，也就是 `${KIMI_CODE_CDN_BASE}/plugins/marketplace.json`。
 */
const CATALOG_URL = 'https://code.kimi.com/kimi-code/plugins/marketplace.json'

const CATALOG = {
  version: '2',
  plugins: [
    {
      id: 'kimi-datasource',
      tier: 'official',
      displayName: 'Kimi Datasource',
      version: '3.3.0',
      description: 'Official datasource workflows.',
      keywords: ['data', 'mcp'],
      source: './official/kimi-datasource',
    },
    {
      id: 'superpowers',
      tier: 'curated',
      displayName: 'Superpowers',
      source: 'https://github.com/obra/superpowers',
    },
  ],
}

function decode(raw: unknown) {
  const decoded = decodeMarketplaceCatalog(raw, '2026-01-01T00:00:00.000Z', CATALOG_URL)

  if (decoded.kind !== 'decoded') {
    throw new Error(`这份目录应当是合法的：${decoded.reason}`)
  }

  return decoded.catalog
}

describe('decodeMarketplaceCatalog', () => {
  it('整份目录能读进来', () => {
    expect(decode(CATALOG).entries).toHaveLength(2)
  })

  /*
   * 断言比的是「解析器对那个绝对地址的答案」，不是一个抄来的字面结构：这个模块负责的
   * 是「相对接到哪」，来源串长什么样归 install-source 与它自己那份测试。
   */
  it('相对来源接到目录文件自己那个地址上', () => {
    expect(decode(CATALOG).entries[0]?.source).toEqual(
      parseInstallSource('https://code.kimi.com/kimi-code/plugins/official/kimi-datasource'),
    )
  })

  it('相对来源不再按字面当成本地路径', () => {
    expect(decode(CATALOG).entries[0]?.source).not.toEqual(
      parseInstallSource('./official/kimi-datasource'),
    )
  })

  it('绝对来源照旧交给同一个解析器', () => {
    expect(decode(CATALOG).entries[1]?.source).toEqual({
      kind: 'github',
      owner: 'obra',
      repo: 'superpowers',
      ref: { kind: 'default-branch' },
    })
  })

  it('tier 折成内部的信任档位', () => {
    expect(decode(CATALOG).entries.map((entry) => entry.trust)).toEqual([
      'kimi-official',
      'curated',
    ])
  })

  /* 没见过的档位意味着没有背书，而没有背书恰好就是第三方的定义 —— 多问一次，不是少问。 */
  it('没见过的 tier 落到第三方，不拖垮整份目录', () => {
    const catalog = decode({ plugins: [{ id: 'x', tier: '未来档位', source: '/x' }] })

    expect(catalog.entries[0]?.trust).toBe('third-party')
  })

  it('上游那几个别名都认', () => {
    const catalog = decode({
      plugins: [
        {
          id: 'aliased',
          name: 'Aliased Plugin',
          shortDescription: '短说明',
          websiteURL: 'https://example.com/aliased',
          downloadUrl: 'https://example.com/aliased.zip',
        },
      ],
    })

    expect(catalog.entries[0]).toMatchObject({
      displayName: 'Aliased Plugin',
      description: '短说明',
      homepage: 'https://example.com/aliased',
    })
    expect(catalog.entries[0]?.source).toEqual(
      parseInstallSource('https://example.com/aliased.zip'),
    )
  })

  it('版本号不参与准入：写什么、不写，都照读', () => {
    expect(decodeMarketplaceCatalog({ version: '1', plugins: [] }, 'now', CATALOG_URL).kind).toBe(
      'decoded',
    )
    expect(decodeMarketplaceCatalog({ version: '9', plugins: [] }, 'now', CATALOG_URL).kind).toBe(
      'decoded',
    )
    expect(decodeMarketplaceCatalog({ plugins: [] }, 'now', CATALOG_URL).kind).toBe('decoded')
  })

  it('没有 plugins 数组的东西不是一份目录', () => {
    expect(decodeMarketplaceCatalog({ version: '2' }, 'now', CATALOG_URL).kind).toBe('undecodable')
  })

  it('一条没有来源的条目让整份目录拒收，并且点名', () => {
    const decoded = decodeMarketplaceCatalog({ plugins: [{ id: 'nowhere' }] }, 'now', CATALOG_URL)

    expect(decoded.kind).toBe('undecodable')
    expect(decoded.kind === 'undecodable' ? decoded.reason : '').toContain('nowhere')
  })
})

describe('市场目录的取用策略', () => {
  it('只有从来没取过才自动拉', () => {
    expect(shouldFetchOnOpen(MARKETPLACE_ABSENT)).toBe(true)
    expect(shouldFetchOnOpen(completeFetch(MARKETPLACE_ABSENT, CATALOG, 'now', CATALOG_URL))).toBe(
      false,
    )
  })

  it('刷新失败时上一份仍然看得见', () => {
    const ready = completeFetch(MARKETPLACE_ABSENT, CATALOG, 'now', CATALOG_URL)
    const failed = failFetch(beginFetch(ready), '网络不通')

    expect(failed.kind).toBe('failed')
    expect(latestCatalog(failed)?.entries).toHaveLength(2)
  })

  it('拉回来一份解不开的目录，等同刷新失败，旧目录不清空', () => {
    const ready = completeFetch(MARKETPLACE_ABSENT, CATALOG, 'now', CATALOG_URL)
    const broken = completeFetch(ready, { version: '2' }, 'later', CATALOG_URL)

    expect(broken.kind).toBe('failed')
    expect(latestCatalog(broken)?.entries).toHaveLength(2)
  })
})
