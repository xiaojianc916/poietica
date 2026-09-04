import type { PromptInputHandle } from '@poietica/assistant'
import type { AttachmentIntake, ComposerAsset } from '@poietica/conversation'
import { type BrowserElementPicked, watchBrowserElementPicked } from '@poietica/native-bridge'
import { warn } from '@poietica/problem'
import type { RefObject } from 'react'

interface BrowserPickTarget {
  readonly ref: RefObject<PromptInputHandle | null>
  readonly intake: AttachmentIntake
}

let target: BrowserPickTarget | null = null
let watching = false

async function deliver(picked: BrowserElementPicked): Promise<void> {
  const destination = target
  const handle = destination?.ref.current ?? null
  if (destination === null || handle === null) {
    warn('拾取结果没有输入框可去，丢弃', { scope: 'browser-pick' })
    return
  }

  let imported: readonly ComposerAsset[]
  try {
    imported = await destination.intake.import([picked.reportPath])
  } catch (cause) {
    warn('元素报告未能作为附件导入', { scope: 'browser-pick', cause })
    return
  }

  const stored = imported[0]
  if (stored === undefined) {
    warn('元素报告导入没有返回附件', { scope: 'browser-pick' })
    return
  }

  const attachment: ComposerAsset = {
    ...stored,
    context: { kind: 'browser-element', label: picked.elementType },
  }

  if (target !== destination || destination.ref.current !== handle) {
    destination.intake.discard(attachment)
    warn('输入框已切换，元素报告附件已释放', { scope: 'browser-pick' })
    return
  }

  handle.attach([attachment], {
    text: picked.comment,
    submit: picked.submission === 'send',
  })
}

export function adoptBrowserPickTarget(
  ref: RefObject<PromptInputHandle | null>,
  intake: AttachmentIntake,
): () => void {
  const destination = { ref, intake }
  target = destination
  if (!watching) {
    watching = true
    watchBrowserElementPicked((picked) => {
      void deliver(picked)
    }).catch((cause: unknown) => {
      watching = false
      warn('浏览器拾取的事件流没接上', { scope: 'browser-pick', cause })
    })
  }
  return () => {
    if (target === destination) {
      target = null
    }
  }
}
