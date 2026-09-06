import type { AttachmentIntake, ComposerAsset } from '@poietica/conversation'
import type { PromptInputHandle } from '@poietica/conversation/surface'
import type { BrowserElementPicked } from '@poietica/native-bridge/browser'

export type BrowserPickMessage = Pick<
  BrowserElementPicked,
  'reportPath' | 'elementType' | 'comment' | 'submission'
>
type Destination = { readonly current: Pick<PromptInputHandle, 'attach'> | null }
interface Dependencies {
  readonly intake: Pick<AttachmentIntake, 'import' | 'discard'>
  readonly watch: (listen: (message: BrowserPickMessage) => void) => Promise<() => void>
  readonly report: (message: string, cause?: unknown) => void
}
export type BrowserPickController = ReturnType<typeof createBrowserPickController>

export function createBrowserPickController(input: Dependencies) {
  let target: Destination | null = null
  let running = false
  let epoch = 0

  async function deliver(picked: BrowserPickMessage, ticket: number): Promise<void> {
    const destination = target
    const handle = destination?.current ?? null
    if (!running || ticket !== epoch) {
      return
    }
    if (destination === null || handle === null) {
      input.report('拾取结果没有输入框可去，丢弃')
      return
    }
    const imported = await input.intake.import([picked.reportPath])
    const stored = imported[0]
    if (stored === undefined) {
      input.report('元素报告导入没有返回附件')
      return
    }
    if (!running || ticket !== epoch || target !== destination || destination.current !== handle) {
      for (const asset of imported) {
        input.intake.discard(asset)
      }
      input.report('输入框已切换，元素报告附件已释放')
      return
    }
    const attachment: ComposerAsset = {
      ...stored,
      context: { kind: 'browser-element', label: picked.elementType },
    }
    try {
      handle.attach([attachment], { text: picked.comment, submit: picked.submission === 'send' })
    } catch (cause) {
      input.intake.discard(attachment)
      throw cause
    } finally {
      for (const surplus of imported.slice(1)) {
        input.intake.discard(surplus)
      }
    }
  }

  return {
    adopt: (destination: Destination): (() => void) => {
      target = destination
      return () => {
        if (target === destination) {
          target = null
        }
      }
    },
    start: (): (() => void) => {
      if (running) {
        throw new Error('Browser pick controller is already started.')
      }
      running = true
      const ticket = ++epoch
      let detach: (() => void) | undefined
      void Promise.resolve()
        .then(() =>
          input.watch((picked) => {
            void deliver(picked, ticket).catch((cause: unknown) => {
              input.report('元素报告未能交付', cause)
            })
          }),
        )
        .then(
          (stop) => {
            if (!running || ticket !== epoch) {
              stop()
              return
            }
            detach = stop
          },
          (cause: unknown) => {
            if (running && ticket === epoch) {
              input.report('浏览器拾取的事件流没接上', cause)
            }
          },
        )
      return () => {
        if (ticket !== epoch) {
          return
        }
        running = false
        epoch += 1
        target = null
        detach?.()
        detach = undefined
      }
    },
  }
}
