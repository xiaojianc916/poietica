import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { currentMath, resetMathForTests } from '../math-plugin'
import { Prose } from '../prose'

/*
 * P-06：公式（katex）按需加载。
 *
 * 顺序有意义：模块级的加载状态在同一个文件里共享，M1 必须在 M2 之前（bun 按书写顺序跑）。
 * 旧代码没有 math-plugin.ts，整份文件在旧代码上直接失败。
 *
 * beforeAll 的复位：`bun test` 单进程跑完全仓，别的文件（如 apps/desktop 的
 * core-recovery.test.tsx）会真的启动一次功能、触发首帧预取，M1 因此会看见它们的脏状态。
 */
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
