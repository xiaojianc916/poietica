import type { Controls, ModelRef, Posture } from '@poietica/engine'
import { createId } from '@poietica/foundation'
import type { ConversationApi } from '../api'
import { type ComposerStore, createComposerStore } from './composer'
import { type ControlsStore, createControlsStore } from './controls'
import { createThreadsStore, type ThreadsStore } from './threads'
import { createTurnStatesStore, type TurnStatesStore } from './turn-states'

export type { TurnStatesStore }

/** 一个线程的输入框句柄：组件拿它读草稿、发消息、改控件 */
export interface ComposerApi {
  readonly threadId: string | null
  readonly draft: import('./composer').Draft
  setText(text: string): void
  addAttachments(items: readonly import('../../ui-api').DraftAttachment[]): void
  removeAttachment(id: string): void
  /** ComposerDraft 的形状（07 页 §5E）：贡献者通过它往草稿里加东西 */
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
  readonly controls: ControlsStore
  /** 某个线程（或 home）的输入框句柄 */
  composerFor(threadId: string | null): ComposerApi
}

export function createStores(
  api: ConversationApi,
  initialDrafts: Readonly<Record<string, import('./composer').Draft>> = {},
): ConversationStores {
  /*
   * turnStates 先建：threads.refresh() 要用它把 `Thread.state` 打底（R-04 §3.5），
   * 构造顺序就是这条依赖的事实。
   */
  const turnStates = createTurnStatesStore()
  const threads = createThreadsStore(api, turnStates)
  const composer = createComposerStore(initialDrafts)
  const controls = createControlsStore(api)

  const stores: ConversationStores = {
    api,
    threads,
    composer,
    turnStates,
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
          // 失败：把正文与附件放回草稿（14 页 §9.5f）
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
          void stores.api.setModel(threadId, model).then((c: Controls) => {
            controls.set(threadId, c)
          })
        },
        setThinking: (level) => {
          if (threadId === null) return
          void stores.api.setThinking(threadId, level).then((c: Controls) => {
            controls.set(threadId, c)
          })
        },
        setPosture: (posture) => {
          if (threadId === null) return
          void stores.api.setPosture(threadId, posture).then((c: Controls) => {
            controls.set(threadId, c)
          })
        },
      }
    },
  }

  return stores
}
