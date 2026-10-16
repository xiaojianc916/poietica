import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { currentMath, resetMathForTests } from '../math-plugin'
import { Prose } from '../prose'

/* P-06 公式（katex）按需加载：模块级加载状态同文件共享，M1 必须排在 M2 之前（bun 按书写顺序跑）。
 * beforeAll 复位：别处的测试（如 core-recovery.test.tsx）会启动功能、触发首帧预取，留下脏状态。 */
beforeAll(() => {
  resetMathForTests()
})

afterEach(() => {
  cleanup()
})

describe('P-06 公式按需加载', () => {
  test('M1 正文里没有 $：渲染之后也不加载公式模块', async () => {
    const { container } = render(<Prose text="普通的一段话，没有公式。" />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(container.textContent).toContain('普通的一段话')
    expect(currentMath()).toBeUndefined()
  })

  test('M2 正文里出现公式：触发加载，到达后同一段正文换成 katex 渲染', async () => {
    const { container } = render(<Prose text="面积是 $x^2$。" />)
    await waitFor(
      () => {
        expect(container.querySelector('.katex')).not.toBeNull()
      },
      { timeout: 5_000 },
    )
    expect(currentMath()).toBeDefined()
  })

  test('M3 模块到达之后新挂载的正文直接带公式渲染', () => {
    const { container } = render(<Prose text="$a+b$" />)
    expect(container.querySelector('.katex')).not.toBeNull()
  })
})
