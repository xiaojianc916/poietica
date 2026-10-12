import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * 逐帧引擎的两条硬规矩（思考行 T-03）：不许在循环里读会强制布局的属性，也不许逐帧进 React。
 *
 * happy-dom 没有真实布局，量不出「一帧里做了几次布局」，所以这两条只能读源码断言 ——
 * 它们是这一层存在的理由（设计文档 §5.4 与「不要做」那一节），一旦被顺手改掉，
 * 真机上的症状是滚动时整页重排，而测试一条都不会红。
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../use-marquee.ts', import.meta.url)), 'utf8')

/** 逐帧循环那一段：从 `const loop` 到下一个顶层 const。 */
const LOOP = SOURCE.slice(SOURCE.indexOf('const loop ='), SOURCE.indexOf('const kick ='))
/** 写 DOM 的那两个小工具也在循环的热路径上，一起算进来。 */
const HOT = `${SOURCE.slice(SOURCE.indexOf('function paint'), SOURCE.indexOf('function markScrolled'))}${LOOP}`

describe('逐帧循环的硬规矩', () => {
  it('循环里不读会强制布局的属性', () => {
    for (const forbidden of [
      'offsetWidth',
      'scrollWidth',
      'clientWidth',
      'getBoundingClientRect',
      'getComputedStyle',
    ]) {
      expect({ attr: forbidden, inLoop: LOOP.includes(forbidden) }).toEqual({ attr: forbidden, inLoop: false })
    }
  })

  it('循环里不进 React：没有 setState，也没有 hook 调用', () => {
    for (const forbidden of ['setState', 'useState', 'useEffect', 'useSyncExternalStore']) {
      expect({ api: forbidden, inLoop: LOOP.includes(forbidden) }).toEqual({ api: forbidden, inLoop: false })
    }
  })

  it('循环里只写 transform 与属性，不写尺寸', () => {
    /* 写 width / height / margin 会引起布局，写 transform 只重绘。 */
    for (const forbidden of ['style.width', 'style.height', 'style.margin', 'style.padding']) {
      expect({ rule: forbidden, inHot: HOT.includes(forbidden) }).toEqual({ rule: forbidden, inHot: false })
    }

    expect(HOT).toContain('style.transform')
    /* 「已经划过」这个记号是属性，不是样式：不给它另开一次样式重算。 */
    expect(HOT).toContain('toggleAttribute')
  })

  it('量宽只经 ResizeObserver，不在循环里现读', () => {
    expect(SOURCE).toContain('new ResizeObserver')

    /*
     * 循环拿几何的那一处读的是观察者写下的缓存（metrics ref），不是元素上的当前尺寸 ——
     * 后者会强制一次同步布局。上面「循环里不读会强制布局的属性」那一条已经把这层意思
     * 钉住了，这里只补上「缓存是观察者填的」这半句。
     */
    const geometryOf = SOURCE.slice(SOURCE.indexOf('const geometry ='), SOURCE.indexOf('const loop ='))

    expect(geometryOf).toContain('metrics.current')
    expect(SOURCE).toContain('metrics.current.viewport = entry')
  })

  it('卸载时取消帧循环、断开两个观察者（删除路径）', () => {
    expect(SOURCE).toContain('cancelAnimationFrame')
    expect(SOURCE).toContain('content.disconnect()')
    expect(SOURCE).toContain('box.disconnect()')
  })

  it('减少动态效果时按 tail 处理：直接摆到最新处，不划', () => {
    /* 那一条分支在挂载时就走掉，不进循环。 */
    expect(SOURCE).toContain("if (mode !== 'glide' || reduced)")
  })
})
