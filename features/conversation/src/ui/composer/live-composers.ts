import { createContext } from 'react'
import type { ComposerDraft } from '../../ui-api'

/**
 * 屏幕上**正在编辑**的那几格对话输入框（按对话号登记；入口页那一格不登记）。
 *
 * 为什么要有它：`stores.composer` 是一份按线程存的草稿模型，而屏幕上的正文活在 Lexical 编辑器里（离屏时存进
 * ComposerDrafts），两边互不相通 —— 往 `stores.composerFor(id).insertText` 写的字不会出现在输入框里。
 * 右坞的辅助对话（「放进输入框」）与其它功能（ConversationUiToken.composerOf）要的是**那一格正在编辑的草稿**：
 * 插字、加附件、提交都与手打一句话走同一条路。没有挂在屏幕上的那一格才退回草稿模型。
 */
export interface LiveComposers {
  /** 输入框挂上时登记，返回注销口；同一条对话后登记的覆盖先登记的（StrictMode 双挂载、切对话时新旧两格交叠） */
  register(threadId: string, draft: ComposerDraft): () => void
  get(threadId: string): ComposerDraft | undefined
}

export function createLiveComposers(): LiveComposers {
  const live = new Map<string, ComposerDraft>()
  return {
    register(threadId, draft) {
      live.set(threadId, draft)
      return () => {
        /* 只注销自己：交叠期间后来的那一格已经覆盖了这条对话，先卸载的旧格不能把它抹掉 */
        if (live.get(threadId) === draft) live.delete(threadId)
      }
    },
    get: (threadId) => live.get(threadId),
  }
}

/** 缺席（测试、单独渲染的输入框）就不登记：插字的一方退回草稿模型 */
export const LiveComposersContext = createContext<LiveComposers | null>(null)
