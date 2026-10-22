import { createContext } from 'react'
import type { FileRef } from './file-ref'

/*
 * 正文里的文件链接点了交给谁。设计系统不认识工作区、右坞与 RPC：宿主（会话的线程表面）提供这一层，正文只负责认出来、画出来。
 * 没有宿主（技能文档、PR 页这类不在对话里的正文）时为 null：链接画成不可点的文件名，行内代码原样画回代码。
 *
 * 住在轻壳一侧（不进 ./prose 的重分块）：宿主在首屏就要挂 Provider，分块里的链接组件读的是同一个 Context 对象。
 */
export interface ProseFileLinks {
  open(ref: FileRef): void
}

export const ProseFileLinksContext = createContext<ProseFileLinks | null>(null)
