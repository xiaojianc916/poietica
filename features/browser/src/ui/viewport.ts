const STILL_FRAMES = 2

export interface ViewportBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ViewportAlignment {
  readonly follow: (signal: unknown) => void
  readonly stop: () => void
}

export function alignViewport(element: Element, report: (bounds: ViewportBounds) => void): ViewportAlignment {
  let frame = 0
  let still = 0
  let last: ViewportBounds | null = null
  const NO_SIGNAL = Symbol('no-signal')
  let signal: unknown = NO_SIGNAL

  const measure = (): void => {
    const rect = element.getBoundingClientRect()

    if (
      last === null ||
      rect.x !== last.x ||
      rect.y !== last.y ||
      rect.width !== last.width ||
      rect.height !== last.height
    ) {
      last = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      still = 0
      report(last)
    } else if (++still >= STILL_FRAMES) {
      frame = 0

      return
    }

    frame = requestAnimationFrame(measure)
  }

  const start = (): void => {
    still = 0

    if (frame === 0) {
      frame = requestAnimationFrame(measure)
    }
  }

  const observer = new ResizeObserver(start)

  observer.observe(element)
  window.addEventListener('resize', start)
  start()

  return {
    follow: (next) => {
      if (next === signal) {
        return
      }

      signal = next
      start()
    },
    stop: () => {
      cancelAnimationFrame(frame)
      frame = 0
      observer.disconnect()
      window.removeEventListener('resize', start)
    },
  }
}
