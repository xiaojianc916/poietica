import type { Controls, ModelRef, Posture } from '@poietica/engine'
import { createId } from '@poietica/foundation'
import type { ConversationApi } from '../api'
import { type ComposerStore, createComposerStore } from '../composer'
import {
  type CompletionUnreadStore,
  createCompletionUnreadStore,
  createThreadsStore,
  createTurnStatesStore,
  type ThreadsStore,
  type TurnStatesStore,
} from '../threads'
import { type ControlsStore, createControlsStore } from './configuration/controls-store'

export interface ComposerApi {
  readonly threadId: string | null
  readonly draft: import('../composer').Draft
  setText(text: string): void
  addAttachments(items: readonly import('../../ui-api').DraftAttachment[]): void
  removeAttachment(id: string): void
  insertText(text: string): void
  submit(deliverAs: 'turn' | 'steer' | 'followUp'): void
  setModel(model: ModelRef): void
  setThinking(level: string): void
  setPosture(posture: Posture): void
}

export interface ConversationStores {
  readonly api: ConversationApi
  readonly threads: ThreadsStore
  readonly composer: ComposerStore
  readonly turnStates: TurnStatesStore
  /** 跑完但还没回来看的那几条（只在内存里，绿点） */
  readonly completionUnread: CompletionUnreadStore
  readonly controls: ControlsStore
  /** 某个线程（或 home）的输入框句柄 */
  composerFor(threadId: string | null): ComposerApi
}

export function createStores(
  api: ConversationApi,
  initialDrafts: Readonly<Record<string, import('../composer').Draft>> = {},
): ConversationStores {
  /*
   * turnStates 先建：threads.refresh() 要用它把 `Thread.state` 打底（R-04 §3.5），
   * 构造顺序就是这条依赖的事实。
   */
  const turnStates = createTurnStatesStore()
  const completionUnread = createCompletionUnreadStore()
  const threads = createThreadsStore(api, turnStates)
  const composer = createComposerStore(initialDrafts)
  const controls = createControlsStore(api)

  /*
   * 换模型 / 档位 / 姿态失败（会话起不来、模型被下架）：重读一次控件表，屏幕回到 agent 手里的真值；
   * 重读也失败时由控件 store 记进 failure，那一条横幅会说原因（AGENTS.md §8.1：void 的 promise 必须带 .catch）。
   */
  const resync = (threadId: string) => (): Promise<void> => controls.refresh(threadId)

  const stores: ConversationStores = {
    api,
    threads,
    composer,
    turnStates,
    completionUnread,
    controls,
    composerFor(threadId) {
      const submit = (deliverAs: 'turn' | 'steer' | 'followUp'): void => {
        if (threadId === null) return
        const current = composer.draft(threadId)
        if (current.text.trim() === '' && current.attachments.length === 0) return
        const clientTurnId = createId()
        const text = current.text
        const attachmentIds = current.attachments.map((a) => a.id)
        const skills = [...current.skills]
        composer.clear(threadId)
        void stores.api.submit({ threadId, clientTurnId, text, attachmentIds, skills, deliverAs }).catch(() => {
          composer.restore(threadId, { text, attachments: current.attachments, skills })
        })
      }

      return {
        threadId,
        get draft() {
          return composer.draft(threadId)
        },
        setText: (text) => {
          composer.setText(threadId, text)
        },
        insertText: (text) => {
          const current = composer.draft(threadId)
          composer.setText(threadId, current.text === '' ? text : `${current.text} ${text}`)
        },
        addAttachments: (items) => {
          composer.addAttachments(threadId, items)
        },
        removeAttachment: (id) => {
          composer.removeAttachment(threadId, id)
        },
        submit,
        setModel: (model) => {
          if (threadId === null) return
          void stores.api
            .setModel(threadId, model)
            .then((c: Controls) => {
              controls.set(threadId, c)
            })
            .catch(resync(threadId))
        },
        setThinking: (level) => {
          if (threadId === null) return
          void stores.api
            .setThinking(threadId, level)
            .then((c: Controls) => {
              controls.set(threadId, c)
            })
            .catch(resync(threadId))
        },
        setPosture: (posture) => {
          if (threadId === null) return
          void stores.api
            .setPosture(threadId, posture)
            .then((c: Controls) => {
              controls.set(threadId, c)
            })
            .catch(resync(threadId))
        },
      }
    },
  }

  return stores
}
