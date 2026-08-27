import type { PromptInputHandle } from '@poietica/agent-ui'
import { warn } from '@poietica/core'
import { type BrowserElementPicked, watchBrowserElementPicked } from '@poietica/ipc'
import type { RefObject } from 'react'
import { formatBrowserElementContext } from './browser-element-context'

let target: RefObject<PromptInputHandle | null> | null = null
let watching = false

function deliver(picked: BrowserElementPicked): void {
  const handle = target?.current ?? null
  if (handle === null) {
    warn('拾取结果没有输入框可去，丢弃', { scope: 'browser-pick' })
    return
  }
  const prompt = formatBrowserElementContext(picked)
  if (picked.submission === 'send') {
    handle.insertTextAndSubmit(prompt)
  } else {
    handle.insertText(prompt)
  }
}

export function adoptBrowserPickTarget(ref: RefObject<PromptInputHandle | null>): () => void {
  target = ref
  if (!watching) {
    watching = true
    watchBrowserElementPicked(deliver).catch((cause: unknown) => {
      watching = false
      warn('浏览器拾取的事件流没接上', { scope: 'browser-pick', cause })
    })
  }
  return () => {
    if (target === ref) {
      target = null
    }
  }
}
