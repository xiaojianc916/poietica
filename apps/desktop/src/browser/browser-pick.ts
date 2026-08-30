import type { PromptInputHandle } from '@poietica/conversation-ui'
import { type BrowserElementPicked, watchBrowserElementPicked } from '@poietica/native-bridge'
import { warn } from '@poietica/problem'
import type { RefObject } from 'react'

let target: RefObject<PromptInputHandle | null> | null = null
let watching = false

/*
 * 正文只带一行摘要与文件路径：完整快照在宿主写好的临时文件里，由 agent 自己去读。
 * 页面内容因此不再进提示词正文，也就不需要信封与转义。
 */
function composePrompt(picked: BrowserElementPicked): string {
  const context = [
    `已选中页面元素：${picked.summary}`,
    `完整的样式、布局、来源与本次改动在这个临时文件里，读它：${picked.reportPath}`,
  ].join('\n')
  const request = picked.comment.trim()

  return request === '' ? context : `${request}\n\n${context}`
}

function deliver(picked: BrowserElementPicked): void {
  const handle = target?.current ?? null
  if (handle === null) {
    warn('拾取结果没有输入框可去，丢弃', { scope: 'browser-pick' })
    return
  }
  const prompt = composePrompt(picked)
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
