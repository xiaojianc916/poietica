import { describe, expect, it } from 'bun:test'
import { agentBareModelId, agentModelDisplayName } from '../model-display'

/*
 * 别名与裸 id 的换算。
 *
 * 判据是对方的两处逐字：校验名单里的 id 不带前缀（handleCatalogAdd 的
 * models.some((m) => m.id === opts.defaultModel)），而成功之后它自己拼回全名
 * （Default model set to ${providerId}/${opts.defaultModel}）。给错一头，
 * 整次写入以 exit 1 收场。
 */
describe('agentBareModelId', () => {
  it('剥掉 provider/ 前缀', () => {
    expect(agentBareModelId('moonshot-cn/kimi-k2.6', 'moonshot-cn')).toBe('kimi-k2.6')
  })

  it('别名本来就没带前缀时原样返回，不猜', () => {
    expect(agentBareModelId('kimi-k2.6', 'moonshot-cn')).toBe('kimi-k2.6')
  })

  it('只剥开头那一段：模型 id 自己带的斜杠不动', () => {
    expect(agentBareModelId('openrouter/moonshotai/kimi-k2', 'openrouter')).toBe(
      'moonshotai/kimi-k2',
    )
  })

  it('前缀只是碰巧同名的一段时不剥', () => {
    expect(agentBareModelId('deepseek-v4-pro', 'deepseek')).toBe('deepseek-v4-pro')
  })
})

describe('agentModelDisplayName', () => {
  it('agent 报的名字与别名不同，以 agent 为准', () => {
    expect(
      agentModelDisplayName({
        alias: 'moonshot-cn/kimi-k3',
        displayName: 'kimi-k3',
        providerId: 'moonshot-cn',
        maxContextSize: 1048576,
        capabilities: [],
        supportEfforts: [],
      }),
    ).toBe('kimi-k3')
  })

  it('没起名（名字就是别名）时查内置表补全', () => {
    expect(
      agentModelDisplayName({
        alias: 'moonshot-cn/kimi-k2.5',
        displayName: 'moonshot-cn/kimi-k2.5',
        providerId: 'moonshot-cn',
        maxContextSize: 262144,
        capabilities: [],
        supportEfforts: [],
      }),
    ).toBe('Kimi K2.5')
  })

  it('内置表不认识的厂商原样显示别名', () => {
    expect(
      agentModelDisplayName({
        alias: 'strange/thing',
        displayName: 'strange/thing',
        providerId: 'strange',
        maxContextSize: 1,
        capabilities: [],
        supportEfforts: [],
      }),
    ).toBe('strange/thing')
  })
})
