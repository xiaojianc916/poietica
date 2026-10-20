import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useTitleMarquee } from '../title-marquee'

const TITLE = 'A Session Title Long Enough To Be Clipped (1)'

function Probe() {
  const ref = useRef<HTMLSpanElement>(null)
  const marquee = useTitleMarquee(ref)

  return (
    <div data-testid="row" onPointerEnter={marquee.enter} onPointerLeave={marquee.leave}>
      <span ref={ref}>{TITLE}</span>
    </div>
  )
}

/** jsdom 不算布局：把这一格的裁切几何直接报出来。 */
function clip(title: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(title, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(title, 'clientWidth', { value: clientWidth, configurable: true })
}

/** 帧回调只排队、不自己跑：逐帧断言爬了多少，才能钉住速度与「到边就停」。 */
function fakeFrames() {
  const pending = new Map<number, FrameRequestCallback>()
  const originalRaf = window.requestAnimationFrame
  const originalCancel = window.cancelAnimationFrame
  let next = 1

  window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
    const handle = next
    next += 1
    pending.set(handle, callback)
    return handle
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((handle: number): void => {
    pending.delete(handle)
  }) as typeof window.cancelAnimationFrame

  return {
    step(now: number): void {
      const first = pending.entries().next()
      if (first.done === true) return
      const [handle, callback] = first.value
      pending.delete(handle)
      callback(now)
    },
    pending(): number {
      return pending.size
    },
    restore(): void {
      window.requestAnimationFrame = originalRaf
      window.cancelAnimationFrame = originalCancel
    },
  }
}

/** 减少动态只替换 matchMedia，帧仍由 fakeFrames 兜住（不该有人排队）。 */
function reducedMotion(matches: boolean) {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia

  return (): void => {
    window.matchMedia = original
  }
}

afterEach(() => {
  cleanup()
})

describe('会话标题的悬停横移', () => {
  test('从第二帧起按 30px/s 匀速爬，两端渐隐跟着位置走，到远端停下并摘掉右端渐隐', () => {
    const frames = fakeFrames()
    const restoreMatchMedia = reducedMotion(false)
    try {
      render(<Probe />)
      const title = screen.getByText(TITLE)
      clip(title, 320, 180)

      fireEvent.pointerEnter(screen.getByTestId('row'))
      /* 第一帧只记下时钟，不动；右端先挂渐隐（还有字没露出来）。 */
      frames.step(16)
      expect(title.scrollLeft).toBe(0)
      expect(title.hasAttribute('data-scrolled')).toBe(false)
      expect(title.hasAttribute('data-clipped')).toBe(true)

      /* 100ms 爬 3px：两端都在裁，所以两只钩子都在。 */
      frames.step(116)
      expect(title.scrollLeft).toBeCloseTo(3, 5)
      expect(title.hasAttribute('data-scrolled')).toBe(true)
      expect(title.hasAttribute('data-clipped')).toBe(true)

      /* 一次推到超过远端：位置夹在 140，右端渐隐摘掉，且不再排队下一帧。 */
      frames.step(5000)
      expect(title.scrollLeft).toBe(140)
      expect(title.hasAttribute('data-scrolled')).toBe(true)
      expect(title.hasAttribute('data-clipped')).toBe(false)
      expect(frames.pending()).toBe(0)
    } finally {
      restoreMatchMedia()
      frames.restore()
    }
  })

  test('指针离开立刻回开头并取消在途的爬动', () => {
    const frames = fakeFrames()
    const restoreMatchMedia = reducedMotion(false)
    try {
      render(<Probe />)
      const title = screen.getByText(TITLE)
      clip(title, 320, 180)
      const row = screen.getByTestId('row')

      fireEvent.pointerEnter(row)
      frames.step(16)
      frames.step(116)
      expect(title.scrollLeft).toBeCloseTo(3, 5)
      expect(frames.pending()).toBe(1)

      fireEvent.pointerLeave(row)
      expect(title.scrollLeft).toBe(0)
      expect(title.hasAttribute('data-scrolled')).toBe(false)
      expect(title.hasAttribute('data-clipped')).toBe(false)
      expect(frames.pending()).toBe(0)
      /* 再推进时间也不会自己爬回去：回程是一步，不是补间。 */
      frames.step(5000)
      expect(title.scrollLeft).toBe(0)
    } finally {
      restoreMatchMedia()
      frames.restore()
    }
  })

  test('放得下或只裁掉 8px 以内不动，多一像素才爬', () => {
    const frames = fakeFrames()
    const restoreMatchMedia = reducedMotion(false)
    try {
      render(<Probe />)
      const title = screen.getByText(TITLE)
      const row = screen.getByTestId('row')

      /* 刚好放不下：不排队、不上钩子。 */
      clip(title, 188, 180)
      fireEvent.pointerEnter(row)
      expect(frames.pending()).toBe(0)
      expect(title.scrollLeft).toBe(0)
      expect(title.hasAttribute('data-clipped')).toBe(false)

      /* 溢出 9px：爬到 9px 的远端。 */
      clip(title, 189, 180)
      fireEvent.pointerEnter(row)
      frames.step(16)
      frames.step(1000)
      expect(title.scrollLeft).toBe(9)
      expect(title.hasAttribute('data-scrolled')).toBe(true)
      expect(title.hasAttribute('data-clipped')).toBe(false)

      fireEvent.pointerLeave(row)
    } finally {
      restoreMatchMedia()
      frames.restore()
    }
  })

  test('减少动态时直接跳到远端，不逐帧爬', () => {
    const frames = fakeFrames()
    const restoreMatchMedia = reducedMotion(true)
    try {
      render(<Probe />)
      const title = screen.getByText(TITLE)
      clip(title, 320, 180)

      fireEvent.pointerEnter(screen.getByTestId('row'))
      expect(title.scrollLeft).toBe(140)
      expect(title.hasAttribute('data-scrolled')).toBe(true)
      expect(title.hasAttribute('data-clipped')).toBe(false)
      expect(frames.pending()).toBe(0)
    } finally {
      restoreMatchMedia()
      frames.restore()
    }
  })
})
