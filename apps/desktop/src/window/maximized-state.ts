import type { MainWindowController } from '@poietica/native-bridge/window'

type Source = Pick<MainWindowController, 'isMaximized' | 'onMaximizedChanged'>
export function observeMaximizedState(
  source: Source,
  publish: (value: boolean) => void,
  report: (stage: 'read' | 'watch', cause: unknown) => void,
): () => void {
  let active = true
  let revision = 0
  let detach: (() => void) | undefined
  async function connect(): Promise<void> {
    try {
      const stop = await source.onMaximizedChanged((value) => {
        if (active) {
          revision += 1
          publish(value)
        }
      })
      if (!active) {
        stop()
        return
      }
      detach = stop
    } catch (cause) {
      if (active) {
        report('watch', cause)
      }
    }
    if (!active) {
      return
    }
    const ticket = revision
    try {
      const value = await source.isMaximized()
      if (active && ticket === revision) {
        publish(value)
      }
    } catch (cause) {
      if (active) {
        report('read', cause)
      }
    }
  }
  void connect()
  return () => {
    active = false
    detach?.()
    detach = undefined
  }
}
