import type { Controls, ModelRef, Posture } from '@poietica/engine'
import { createId } from '@poietica/foundation'
import type { ConversationApi } from '../api'
import { type ComposerStore, createComposerStore } from './composer'
import { type ControlsStore, createControlsStore } from './controls'
import { createInteractionsStore, type InteractionsStore } from './interactions'
import { createQueueStore, type QueueStore } from './queue'
import { createThreadsStore, type ThreadsStore } from './threads'
import { createTimelinesStore, type TimelinesStore } from './timelines'
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
  readonly timelines: TimelinesStore
  readonly composer: ComposerStore
  readonly turnStates: TurnStatesStore
  readonly controls: ControlsStore
  readonly queue: QueueStore
  readonly interactions: InteractionsStore
  /** 某个线程（或 home）的输入框句柄 */
  composerFor(threadId: string | null): ComposerApi
}

export function createStores(
  api: ConversationApi,
  initialDrafts: Readonly<Record<string, import('./composer').Draft>> = {},
): ConversationStores {
  const threads = createThreadsStore(api)
  const timelines = createTimelinesStore(api)
  const composer = createComposerStore(initialDrafts)
  const turnStates = createTurnStatesStore()
  const controls = createControlsStore(api)
  const queue = createQueueStore(api)
  const interactions = createInteractionsStore(api)

  const stores: ConversationStores = {
    api,
    threads,
    timelines,
    composer,
    turnStates,
    controls,
    queue,
    interactions,
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
