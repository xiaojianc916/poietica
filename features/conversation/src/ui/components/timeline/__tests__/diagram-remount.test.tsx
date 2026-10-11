import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

/*
 * 图所在的行会被虚拟器卸载；回来时不该重跑一遍布局引擎，也不该先出一帧源码面板。
 *
 * 引擎与取色都换成替身：
 *   • `@streamdown/mermaid` 真的会去 import mermaid（几百毫秒、还带真布局），
 *     这里只要一个会数数的 render；`initialize` 收下的颜色也顺手记下来，好断言重挂载
 *     那次没再初始化；
 *   • `diagram-theme` 的探针要真实样式引擎 + 2d 画布，happy-dom 两者都不给，直接给固定色。
 *
 * 替身交回的 svg 照真实引擎的样子带 xmlns：happy-dom 按命名空间建元素，缺了它连
 * `viewBox` 都没有（`ground()` 读不到），而那只关测试环境。
 */

let renderCount = 0
let initCount = 0

const INKS = {
  background: 'transparent',
  clusterBkg: 'rgb(1, 1, 1)',
  clusterBorder: 'rgb(2, 2, 2)',
  edgeLabelBackground: 'rgb(3, 3, 3)',
  lineColor: 'rgb(4, 4, 4)',
  mainBkg: 'rgb(5, 5, 5)',
  primaryBorderColor: 'rgb(6, 6, 6)',
  primaryColor: 'rgb(7, 7, 7)',
  primaryTextColor: 'rgb(8, 8, 8)',
  secondaryColor: 'rgb(9, 9, 9)',
  tertiaryColor: 'rgb(10, 10, 10)',
  textColor: 'rgb(11, 11, 11)',
}

mock.module('@streamdown/mermaid', () => ({
  mermaid: {
    getMermaid: () => ({
      initialize: () => {
        initCount += 1
      },
      render: (id: string) => {
        renderCount += 1

        return Promise.resolve({
          svg: `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><g id="${id}"><rect /></g></svg>`,
        })
      },
    }),
  },
}))

mock.module('../diagram-theme', () => ({
  diagramInks: () => INKS,
}))

const { cleanup, render, waitFor } = await import('@testing-library/react')
const { resetDiagramCacheForTests } = await import('../diagram-cache')
const { Diagram } = await import('../diagram')

beforeEach(() => {
  renderCount = 0
  initCount = 0
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

  /* 首次挂载没有缓存可命中：第一帧仍是源码面板，等引擎画完换成图。 */
  expect(viewOf(first.container)).toBe('code')

  await waitFor(() => {
    expect(viewOf(first.container)).toBe('diagram')
  })

  expect(renderCount).toBe(1)
  /* 画一次只需初始化一次；重挂载命中缓存时连它也不该再跑。 */
  expect(initCount).toBe(1)

  const painted = first.container.querySelector('.timeline-prose__diagram-stage svg')

  expect(painted).not.toBeNull()

  cleanup()

  /* 同一张源码重新挂载（虚拟器把行卸载又铺回来）：第一帧就该是图。 */
  const second = render(<Diagram code="graph TD;A-->B" isIncomplete={false} />)

  expect(viewOf(second.container)).toBe('diagram')
  expect(second.container.querySelector('.timeline-prose__diagram-stage svg')).not.toBeNull()

  await waitFor(() => {
    expect(second.container.querySelector('.timeline-prose__diagram-stage svg')).not.toBeNull()
  })

  expect(renderCount).toBe(1)
  expect(initCount).toBe(1)
})

test('D2 换一段源码不命中：照常重画，重画的结果也进缓存', async () => {
  const first = render(<Diagram code="graph TD;A-->B" isIncomplete={false} />)

  await waitFor(() => {
    expect(viewOf(first.container)).toBe('diagram')
  })

  cleanup()

  const second = render(<Diagram code="graph TD;A-->C" isIncomplete={false} />)

  await waitFor(() => {
    expect(viewOf(second.container)).toBe('diagram')
  })

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

  await waitFor(() => {
    expect(viewOf(closed.container)).toBe('diagram')
  })

  expect(renderCount).toBe(1)
})
