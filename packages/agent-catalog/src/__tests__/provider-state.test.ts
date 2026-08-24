import { describe, expect, it } from 'bun:test'
import { parseAgentProviderList, parseAgentProviderListOutput } from '../provider-state'

/*
 * 合成 provider 的 id 由调用方从 agent 档案给，解析层不认识任何一家 —— 这个模块
 * 连 agent 名单都不认识，所以这里写字面量。它与 kimi 档案里那一格对得上，由
 * kimi/__tests__/descriptor.test.ts 钉住；两边走样时那一条先响。
 */
const SYNTHETIC = '__kimi_env__'

/*
 * 形状照 apps/kimi-code/test/cli/provider.test.ts 里断言过的那一份：providers 与
 * models 两张表，别名是 <providerId>/<modelId>，apiJson 来源的 source 里连 key
 * 一起存着。
 */
const listed = {
  providers: {
    kohub: {
      type: 'anthropic',
      apiKey: 'sk-test-token',
      baseUrl: 'https://registry.example.com',
      source: {
        kind: 'apiJson',
        url: 'https://registry.example.com/v1/models/api.json',
        apiKey: 'sk-test-token',
      },
    },
    manual: { type: 'openai', env: { OPENAI_API_KEY: 'sk-manual' } },
    lonely: { type: 'openai' },
    __kimi_env__: { type: 'kimi', apiKey: 'sk-from-env' },
  },
  models: {
    'kohub/a': { provider: 'kohub', displayName: 'Model A', maxContextSize: 200000 },
    'kohub/b': { provider: 'kohub', name: 'Model B', capabilities: ['tool_use', 'thinking'] },
    'manual/c': { provider: 'manual', supportEfforts: ['low', 'high'] },
  },
}

describe('parseAgentProviderList', () => {
  it('按 provider 归拢模型', () => {
    const snapshot = parseAgentProviderList(listed, SYNTHETIC)

    expect(snapshot.providers.map((one) => one.id)).toEqual([
      '__kimi_env__',
      'kohub',
      'lonely',
      'manual',
    ])

    const kohub = snapshot.providers.find((one) => one.id === 'kohub')

    expect(kohub?.models.map((model) => model.alias)).toEqual(['kohub/a', 'kohub/b'])
  })

  /*
   * 这条是这个模块存在的理由。上游把整张配置表原样序列化，四个位置可能有明文
   * key，而 models 的 schema 还是 passthrough。任何一处漏出来都会进渲染层。
   */
  it('凭据的值一个字都不越过边界', () => {
    const snapshot = parseAgentProviderList(listed, SYNTHETIC)
    const serialized = JSON.stringify(snapshot)

    expect(serialized).not.toContain('sk-test-token')
    expect(serialized).not.toContain('sk-manual')
    expect(serialized).not.toContain('sk-from-env')
  })

  it('注册表地址留下，同一个 source 里的 key 不留', () => {
    const snapshot = parseAgentProviderList(listed, SYNTHETIC)
    const kohub = snapshot.providers.find((one) => one.id === 'kohub')

    expect(kohub?.registryUrl).toBe('https://registry.example.com/v1/models/api.json')
  })

  it('认得三种凭据来源，也认得没配过', () => {
    const snapshot = parseAgentProviderList(listed, SYNTHETIC)
    const kinds = new Map(snapshot.providers.map((one) => [one.id, one.credentialKind]))

    expect(kinds.get('kohub')).toBe('apiKey')
    expect(kinds.get('manual')).toBe('env')
    expect(kinds.get('lonely')).toBe('none')

    const lonely = snapshot.providers.find((one) => one.id === 'lonely')

    expect(lonely?.configured).toBe(false)
  })

  it('oauth 压过 apiKey', () => {
    const snapshot = parseAgentProviderList(
      {
        providers: { one: { oauth: { storage: 'file', key: 'k' }, apiKey: 'sk-x' } },
        models: {},
      },
      SYNTHETIC,
    )

    expect(snapshot.providers[0]?.credentialKind).toBe('oauth')
  })

  it('标出环境变量合成的保留条目', () => {
    const snapshot = parseAgentProviderList(listed, SYNTHETIC)
    const synthetic = snapshot.providers.filter((one) => one.synthetic)

    expect(synthetic.map((one) => one.id)).toEqual(['__kimi_env__'])
  })

  it('缺 provider 字段时退回别名前缀', () => {
    const snapshot = parseAgentProviderList(
      {
        providers: { acme: { type: 'openai' } },
        models: { 'acme/fast': { name: 'Fast' } },
      },
      SYNTHETIC,
    )

    expect(snapshot.providers[0]?.models.map((model) => model.alias)).toEqual(['acme/fast'])
    expect(snapshot.orphanModels).toHaveLength(0)
  })

  it('指向不存在 provider 的模型进 orphan 并记一条', () => {
    const snapshot = parseAgentProviderList(
      {
        providers: {},
        models: { 'ghost/x': { provider: 'ghost' } },
      },
      SYNTHETIC,
    )

    expect(snapshot.orphanModels.map((model) => model.alias)).toEqual(['ghost/x'])
    expect(snapshot.issues).toHaveLength(1)
  })

  it('显示名依次退回 displayName、name、别名', () => {
    const snapshot = parseAgentProviderList(listed, SYNTHETIC)
    const kohub = snapshot.providers.find((one) => one.id === 'kohub')

    expect(kohub?.models[0]?.displayName).toBe('Model A')
    expect(kohub?.models[1]?.displayName).toBe('Model B')

    const bare = parseAgentProviderList({ providers: { a: {} }, models: { 'a/b': {} } }, SYNTHETIC)

    expect(bare.providers[0]?.models[0]?.displayName).toBe('a/b')
  })

  it('不是对象时给空投影而不是抛错', () => {
    expect(parseAgentProviderList(null, SYNTHETIC).providers).toEqual([])
    expect(parseAgentProviderList(null, SYNTHETIC).issues).toHaveLength(1)
  })
})

describe('parseAgentProviderListOutput', () => {
  it('解析 CLI 的 stdout', () => {
    const snapshot = parseAgentProviderListOutput(JSON.stringify(listed), SYNTHETIC)

    expect(snapshot.providers).toHaveLength(4)
  })

  it('空输出与坏 JSON 各记一条 issue', () => {
    expect(parseAgentProviderListOutput('   ', SYNTHETIC).issues).toHaveLength(1)
    expect(parseAgentProviderListOutput('{ not json', SYNTHETIC).issues).toHaveLength(1)
  })
})
