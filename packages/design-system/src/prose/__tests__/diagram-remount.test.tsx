import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

/*
 * 图行会被虚拟器卸载；回来时不该重跑布局引擎，也不该先出一帧源码面板。引擎换成替身：真 pele 能跑，
 * 但这里量的是缓存与相位，不是布局 —— 替身记次数即可。
 *
 * pele 是同步的：一次 render 就是一张 svg 字符串，没有「上一张还没画完」的异步竞态，所以这里的
 * 断言从「等它画完」变成「挂载那一刻就该是图或源码，且引擎调用次数对得上」。
 */

let renderCount = 0

mock.module('pele', () => ({
  render: (code: string) => {
    renderCount += 1

    return {
      svg: `<svg viewBox="0 0 10 10" width="10" height="10" style="max-width:100%;height:auto" xmlns="http://www.w3.org/2000/svg"><g><rect data-code="${code.length}" /></g></svg>`,
      width: 10,
      height: 10,
      links: [],
      type: 'flowchart',
    }
  },
}))

const { cleanup, render, waitFor } = await import('@testing-library/react')
const { resetDiagramCacheForTests } = await import('../diagram-cache')
const { Diagram } = await import('../diagram')

beforeEach(() => {
  renderCount = 0
  resetDiagramCacheForTests()
})

afterEach(() => {
  cleanup()
})

function viewOf(container: HTMLElement): string | null | undefined {
  return container.querySelector('.timeline-prose__diagram')?.getAttribute('data-view')
}

test('D1 重挂载命中缓存：引擎只画一次，且首帧就是图', async () => {
  const first = render(<Diagram code="graph TD;A-->B" isIncomplete={false} />)

  /* 同步引擎：图在渲染期就画好，首帧直接是图 —— 虚拟器不会先量到一版源码面板的高度。 */
  expect(viewOf(first.container)).toBe('diagram')
  expect(renderCount).toBe(1)
  expect(first.container.querySelector('.timeline-prose__diagram-stage svg')).not.toBeNull()

  cleanup()

  /* 同一张源码重新挂载（虚拟器把行卸载又铺回来）：首帧就该是图。 */
  const second = render(<Diagram code="graph TD;A-->B" isIncomplete={false} />)

  expect(viewOf(second.container)).toBe('diagram')
  expect(second.container.querySelector('.timeline-prose__diagram-stage svg')).not.toBeNull()
  expect(renderCount).toBe(1)
})

test('D2 换一段源码不命中：照常重画，重画的结果也进缓存', async () => {
  const first = render(<Diagram code="graph TD;A-->B" isIncomplete={false} />)

  await waitFor(() => {
    expect(viewOf(first.container)).toBe('diagram')
  })

  cleanup()

  const second = render(<Diagram code="graph TD;A-->C" isIncomplete={false} />)

  expect(viewOf(second.container)).toBe('diagram')
  expect(renderCount).toBe(2)

  cleanup()

  const again = render(<Diagram code="graph TD;A-->C" isIncomplete={false} />)

  expect(viewOf(again.container)).toBe('diagram')
  expect(renderCount).toBe(2)
})

test('D3 围栏还没闭合时不画；闭合后画一次，之后再挂载不再画', async () => {
  const open = render(<Diagram code="graph TD;A-->B" isIncomplete />)

  expect(viewOf(open.container)).toBe('code')
  expect(renderCount).toBe(0)

  cleanup()

  const closed = render(<Diagram code="graph TD;A-->B" isIncomplete={false} />)

  expect(viewOf(closed.container)).toBe('diagram')
  expect(renderCount).toBe(1)
})

/* 图的尺寸只能是「自然宽高 + 只缩不放」。写成 width:100% 时，pele 排出的紧凑图（三节点流程图约 160×64）
   会被连字号一起放大到满栏 —— 真实故障：一张 sequenceDiagram 的字大得糊在屏幕上。 */
test('D4 图的尺寸原样保留，不被强制铺满栏宽', () => {
  const view = render(<Diagram code="graph TD;A-->B" isIncomplete={false} />)
  const svg = view.container.querySelector<SVGSVGElement>('.timeline-prose__diagram-stage svg')

  expect(svg).not.toBeNull()
  /* 替身带的是 width/height="10"，这正是引擎交回来的自然尺寸；组件不该改它。 */
  expect(svg?.getAttribute('width')).toBe('10')
  expect(svg?.getAttribute('height')).toBe('10')
  expect(svg?.style.width).not.toBe('100%')
})
