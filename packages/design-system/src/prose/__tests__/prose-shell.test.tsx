import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Prose, prefetchProseWhenIdle, preloadProse, resetProseForTests, useProseSettled } from '../prose-shell'

/* 性能方案 P5：正文排版的实现在独立分块里，入口只留轻壳。这里钉轻壳的五条承诺：到达前按源码显示、到达后换成排版；
 * 到不了也算落定（等它的那一层不能一直空着）；预取同一次启动只排一次；失败交给上报、下一次触发重试；
 * 落定之后不回落（失败后的重试在途时，已经放行的那一层不收回）。
 * 每条之后复位回真实的动态 import：bun test 各文件共享同一份模块实例，不能把桩留给别的文件。 */
afterEach(() => {
  cleanup()
  resetProseForTests()
})

type ProseModule = typeof import('../prose')

function deferredLoader(): { readonly loader: () => Promise<ProseModule>; readonly release: () => void } {
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { loader: () => gate.then(() => import('../prose')), release: () => release() }
}

function SettledProbe() {
  return <output data-settled={String(useProseSettled())} />
}

describe('P5 正文排版轻壳', () => {
  test('S1 实现到达之前按源码原样显示，到达之后换成排版', async () => {
    const { loader, release } = deferredLoader()
    resetProseForTests(loader)
    const text = '**粗体**\n\n第二段'
    const { container } = render(<Prose text={text} />)

    const source = container.querySelector('.timeline-prose--source')
    expect(source?.textContent).toBe(text)
    expect(container.querySelector('[data-streamdown="strong"]')).toBeNull()

    await act(async () => {
      release()
      await preloadProse()
    })
    expect(container.querySelector('.timeline-prose--source')).toBeNull()
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('粗体')
  })

  test('S2 到不了也算落定：等它的那一层放行，正文保持源码显示', async () => {
    resetProseForTests(() => Promise.reject(new Error('分块丢了')))
    const { container } = render(
      <>
        <SettledProbe />
        <Prose text="**粗体**" />
      </>,
    )
    expect(container.querySelector('output')?.dataset.settled).toBe('false')

    await waitFor(() => {
      expect(container.querySelector('output')?.dataset.settled).toBe('true')
    })
    expect(container.querySelector('.timeline-prose--source')?.textContent).toBe('**粗体**')
  })

  test('S3 预取同一次启动只排一次；在途或已到时 preloadProse 不再起第二次加载', async () => {
    let calls = 0
    resetProseForTests(() => {
      calls += 1
      return import('../prose')
    })
    prefetchProseWhenIdle()
    prefetchProseWhenIdle()
    await waitFor(() => {
      expect(calls).toBe(1)
    })
    await preloadProse()
    await preloadProse()
    expect(calls).toBe(1)

    const { container } = render(<Prose text="**粗体**" />)
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('粗体')
  })

  test('S4 预取失败交给上报；下一次触发重试成功', async () => {
    let fail = true
    resetProseForTests(() => (fail ? Promise.reject(new Error('分块丢了')) : import('../prose')))
    const reported: unknown[] = []
    prefetchProseWhenIdle((cause) => reported.push(cause))
    await waitFor(() => {
      expect(reported).toHaveLength(1)
    })
    expect(String(reported[0])).toContain('分块丢了')

    fail = false
    await preloadProse()
    const { container } = render(<Prose text="**粗体**" />)
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('粗体')
  })

  test('S5 落定之后不回落：失败后的重试在途时，等它的那一层保持放行', async () => {
    const retry = deferredLoader()
    let fail = true
    resetProseForTests(() => (fail ? Promise.reject(new Error('分块丢了')) : retry.loader()))
    await preloadProse().catch(() => undefined)

    fail = false
    const tree = () => (
      <>
        <SettledProbe />
        <Prose text="**粗体**" />
      </>
    )
    const { container, rerender } = render(tree())
    /* Prose 挂载即重试；重试在途时那一层因为别的原因重渲染（时间线的 props 变了），仍保持放行，正文仍是源码 */
    rerender(tree())
    expect(container.querySelector('output')?.dataset.settled).toBe('true')
    expect(container.querySelector('.timeline-prose--source')?.textContent).toBe('**粗体**')

    await act(async () => {
      retry.release()
      await preloadProse()
    })
    expect(container.querySelector('output')?.dataset.settled).toBe('true')
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('粗体')
  })
})
