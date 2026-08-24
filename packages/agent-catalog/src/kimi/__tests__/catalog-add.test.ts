import { describe, expect, it } from 'bun:test'
import { kimiCatalogAddArgs } from '../catalog-add'

describe('kimiCatalogAddArgs', () => {
  it('只给厂商时不带任何可选参数', () => {
    expect(kimiCatalogAddArgs({ providerId: 'anthropic' })).toEqual([
      'provider',
      'catalog',
      'add',
      'anthropic',
    ])
  })

  it('默认模型与基础地址各自可选', () => {
    expect(
      kimiCatalogAddArgs({
        providerId: 'deepseek',
        defaultModelId: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
      }),
    ).toEqual([
      'provider',
      'catalog',
      'add',
      'deepseek',
      '--default-model',
      'deepseek-v4-pro',
      '--base-url',
      'https://api.deepseek.com',
    ])
  })

  /*
   * 这条是这个函数存在的理由之一。原生侧的 FORBIDDEN_FLAGS 会拒掉 --api-key，因为
   * Windows 上任何用户都读得到别的进程的完整命令行。参数由这里构造，就不会有人在调用点
   * 顺手拼一个上去。
   */
  it('永远不会产出 --api-key', () => {
    const args = kimiCatalogAddArgs({
      providerId: 'deepseek',
      defaultModelId: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
    })

    expect(args.join(' ')).not.toContain('--api-key')
  })

  it('拦下不能出现在命令行上的值', () => {
    expect(() => kimiCatalogAddArgs({ providerId: 'a;rm -rf /' })).toThrow()
    expect(() => kimiCatalogAddArgs({ providerId: '' })).toThrow()
    expect(() => kimiCatalogAddArgs({ providerId: 'deepseek', defaultModelId: 'x y' })).toThrow()
  })
})
