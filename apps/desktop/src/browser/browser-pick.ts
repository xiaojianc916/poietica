import type { PromptInputHandle } from '@poietica/agent-ui'
import { warn } from '@poietica/core'
import { type BrowserElementPicked, watchBrowserElementPicked } from '@poietica/ipc'
import type { RefObject } from 'react'

/*
 * 拾取结果到对话草稿的唯一路由。
 *
 * 数据从哪来、经过谁、到哪去：宿主发拾取事件，这里把它排成一段文字，写进
 * 屏幕上这一格对话的输入框。草稿的唯一真相在 PromptInput，这里不缓存文本。
 *
 * 单目标而不是列表：工作台主区同一时刻只挂一个对话表面（见
 * workspace-container 的 surface 槽），谁在屏幕上谁认领。没有目标时丢弃并记
 * 日志，不排队 —— 排队意味着旧拾取会在人切回对话时突然砸进草稿。
 */

let target: RefObject<PromptInputHandle | null> | null = null
let watching = false

function formatPick(picked: BrowserElementPicked): string {
  const fence = '```'
  const lines = [
    `【网页元素】${picked.title === '' ? picked.url : picked.title}`,
    `URL：${picked.url}`,
    `选择器：${picked.selector}`,
  ]

  if (picked.text !== '') {
    lines.push(`文本：${picked.text}`)
  }

  if (picked.html !== '') {
    lines.push(`${fence}html`, picked.html, fence)
  }

  return lines.join('\n')
}

function deliver(picked: BrowserElementPicked): void {
  const handle = target?.current ?? null

  if (handle === null) {
    warn('拾取结果没有输入框可去，丢弃', { scope: 'browser-pick' })

    return
  }

  handle.insertText(formatPick(picked))
}

/**
 * 认领拾取目标，返回注销函数。后认领顶替先认领（屏幕上只有一格）；注销只在
 * 自己仍是目标时清空。首次认领才挂宿主事件流 —— 惰性，不多一条常驻监听。
 */
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
