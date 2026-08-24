import { describe, expect, it } from 'bun:test'

import { describeSurface, SURFACE_NAVIGATION_ORDER, SURFACE_REGISTRY } from './surface-registry'

/*
 * 图标齐不齐由类型看住：presentation 侧的 SURFACE_ICONS 是
 * Record<SurfaceIconId, SurfaceIcon>，漏一枚是编译错误。
 * 所以这里只测领域层自己说得清的三件事。
 */
describe('工作区表面注册表', () => {
  it('导航顺序由 navigationOrder 派生，凡进导航的表面一个不落', () => {
    const expected = Object.entries(SURFACE_REGISTRY)
      .filter(([, descriptor]) => descriptor.navigationOrder !== null)
      .sort((a, b) => (a[1].navigationOrder ?? 0) - (b[1].navigationOrder ?? 0))
      .map(([id]) => id)

    expect([...SURFACE_NAVIGATION_ORDER]).toEqual(expected)

    /* 新建对话是动作而非导航目标，由导航条单独渲染。 */
    expect(SURFACE_NAVIGATION_ORDER).not.toContain('ai')
    expect(new Set(SURFACE_NAVIGATION_ORDER).size).toBe(SURFACE_NAVIGATION_ORDER.length)
  })

  it('每个表面都有标题与描述', () => {
    for (const surfaceId of Object.keys(SURFACE_REGISTRY)) {
      const descriptor = describeSurface(surfaceId as never)

      expect(descriptor.title.length).toBeGreaterThan(0)
      expect(descriptor.description.length).toBeGreaterThan(0)
    }
  })

  it('不含已废弃的旧域表面', () => {
    const keys = Object.keys(SURFACE_REGISTRY)

    /*
     * data / pages 是历代旧名；documents / layers / relations / assets /
     * extensions 随旧产品形态整包移出。导航项与表面是同一个概念，不存在
     * 第二种导航 ID。
     */
    for (const deprecated of [
      'data',
      'pages',
      'documents',
      'layers',
      'relations',
      'assets',
      'extensions',
    ]) {
      expect(keys).not.toContain(deprecated)
    }
  })
})
