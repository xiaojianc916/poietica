import {
  type AgentQuestionChoice,
  type AgentQueuedState,
  type AgentTranscriptEvent,
  commands,
  events,
} from '@poietica/contract'
import type {
  AgentSessionPort,
  MessageQueueMode,
  QuestionChoice,
  QueuedMessages,
  TranscriptCatchUp,
} from '@poietica/conversation'
import { transcriptOpsCatchupResponseSchema } from '@poietica/transcript'
import { throughIpc } from '../ipc-error'
import {
  type AgentEventSourceOptions,
  subscribeToEvent,
  subscribeToSessionEvent,
} from './event-subscription'
import type { AgentBridgeOptions } from './launch-contract'
import { decodeTranscriptEvent, transcriptPageOf } from './transcript-decoding'

/** 线上那一份队列 → 会话层的形状。字段同名，只做一次 readonly 复制。 */
function queuedOf(queue: AgentQueuedState): QueuedMessages {
  return {
    sessionId: queue.sessionId,
    steering: [...queue.steering],
    followUp: [...queue.followUp],
    steeringMode: modeOf(queue.steeringMode),
    followUpMode: modeOf(queue.followUpMode),
    interruptMode: interruptOf(queue.interruptMode),
  }
}

/*
 * 模式取值域是 omp 自己的两个枚举（设置注册表里的 steeringMode / followUpMode /
 * interruptMode）。线上是自由字符串（原生侧不替上游把关），认不出来就**报错**：
 * 猜一个默认值等于把「它说 A 我当 B」按下去，屏幕上会静默换了行为。
 */
function modeOf(value: string): MessageQueueMode {
  if (value === 'all' || value === 'one-at-a-time') {
    return value
  }
  throw new Error(`agent 报了一个不认识的队列模式：${value}`)
}

function interruptOf(value: string): 'immediate' | 'wait' {
  if (value === 'immediate' || value === 'wait') {
    return value
  }
  throw new Error(`agent 报了一个不认识的中断模式：${value}`)
}

function questionChoiceOf(choice: QuestionChoice): AgentQuestionChoice {
  switch (choice.kind) {
    case 'single':
      return { kind: 'single', optionId: choice.optionId }
    case 'multi':
      return { kind: 'multi', optionIds: [...choice.optionIds] }
    case 'other':
      return { kind: 'other', text: choice.text }
    case 'multi_with_other':
      return {
        kind: 'multi_with_other',
        optionIds: [...choice.optionIds],
        otherText: choice.otherText,
      }
    case 'skipped':
      return { kind: 'skipped' }
  }
}
export function createAgentSessionPort({
  ready,
  cwd,
  onListenFailure,
}: AgentBridgeOptions & AgentEventSourceOptions): AgentSessionPort {
  return {
    transcript: {
      subscribeTranscript: (listener) =>
        subscribeToEvent<AgentTranscriptEvent>(
          (receive) => events.agentTranscriptEvent(receive),
          (wire) => {
            const decoded = decodeTranscriptEvent(wire)
            if (decoded.ok) {
              listener(decoded.signal)
              return
            }
            onListenFailure?.(decoded.error, 'decode')
            listener({
              kind: 'resync',
              sessionId: wire.sessionId,
              reason: 'invalid transcript event',
            })
          },
          onListenFailure,
        ),
      readTranscript: async (sessionId, agentId, beforeTurn) => {
        const wire = await throughIpc(() =>
          commands.agentTranscript({ sessionId, agentId, beforeTurn: beforeTurn ?? null }),
        )
        return transcriptPageOf(wire.json)
      },
      catchUpTranscript: async (sessionId, agentId, sinceSeq) => {
        const wire = await throughIpc(() =>
          commands.agentTranscriptOps({ sessionId, agentId, sinceSeq }),
        )
        const data = transcriptOpsCatchupResponseSchema.parse(wire.json)
        return {
          agentId: data.agent_id,
          batches: data.batches,
          latestSeq: data.latest_seq,
          complete: data.complete,
        } as TranscriptCatchUp
      },
      /* 历史图片链路至今 unwired（agent-client 的 read_media 恒返回 Err）：调用即失败，
         store 降级为占位图。 */
      readMedia: async (sessionId, fileId) => {
        const wire = await throughIpc(() => commands.agentSessionMedia({ sessionId, fileId }))
        return { mediaType: wire.contentType, base64: wire.base64 }
      },
    },
    prompt: async (request) => {
      await ready()
      const started = await throughIpc(() =>
        commands.agentPrompt({
          text: request.text,
          deliverAs: request.deliverAs,
          threadId: request.threadId,
          configuration: request.configuration.map((selected) => ({
            id: selected.id,
            value: selected.value,
          })),
          /* readonly 的数组与生成绑定要的可变数组是两个类型，所以复制一次 ——
          数组复制只在这一层做。 */
          skills: request.skills.map((skill) => ({
            name: skill.name,
            args: skill.args ?? null,
          })),
          assets: request.assets.map((asset) => ({
            sessionToken: asset.sessionToken,
            assetToken: asset.assetToken,
            filename: asset.filename,
            kind: asset.kind,
          })),
          cwd: cwd?.() ?? null,
        }),
      )

      return started
    },

    cancel: async (threadId) => {
      await throughIpc(() => commands.agentCancel({ threadId }))
    },

    /* 队列三件事：读、撤、改模式。队列的真相在 agent 里，这一层只搬。 */
    readQueue: async () => queuedOf(await throughIpc(() => commands.agentQueue())),
    withdraw: async () => {
      const restored = await throughIpc(() => commands.agentWithdraw())
      return restored === null ? null : { text: restored.text }
    },
    setDeliveryModes: async (patch) =>
      queuedOf(
        await throughIpc(() =>
          commands.agentSetDeliveryModes({
            steeringMode: patch.steeringMode ?? null,
            followUpMode: patch.followUpMode ?? null,
            interruptMode: patch.interruptMode ?? null,
          }),
        ),
      ),

    subscribeQueue: (listener) =>
      subscribeToSessionEvent(
        'queue',
        (payload) => {
          listener(queuedOf(payload.queue))
        },
        onListenFailure,
      ),

    subscribePromptDropped: (listener) =>
      subscribeToSessionEvent(
        'promptDropped',
        (payload) => {
          listener({ sessionId: payload.sessionId, text: payload.text })
        },
        onListenFailure,
      ),

    /* 与上游那条同形：本机判定的一轮失败，带会话号交回上层认领。 */
    subscribeRunFailed: (listener) =>
      subscribeToSessionEvent(
        'runFailed',
        (payload) => {
          listener({
            sessionId: payload.sessionId,
            message: payload.message,
            degraded: payload.degraded,
          })
        },
        onListenFailure,
      ),

    abortPrompt: async (threadId, promptId) => {
      await throughIpc(() => commands.agentAbortPrompt({ threadId, promptId }))
    },

    resolvePermission: async (requestId, answer) => {
      await throughIpc(() =>
        commands.agentResolvePermission({
          requestId,
          decision: answer.decision,
          scope: answer.scope ?? null,
          selectedLabel: answer.selectedLabel ?? null,
          feedback: answer.feedback ?? null,
        }),
      )
    },

    answerQuestions: async (response) => {
      await throughIpc(() =>
        commands.agentAnswerQuestions({
          questionId: response.questionId,
          /* 同上：readonly 的数组要复制成可变的。 */
          answers: response.answers.map((answered) => ({
            questionId: answered.questionId,
            answer: questionChoiceOf(answered.answer),
          })),
          method: response.method ?? null,
          note: response.note ?? null,
        }),
      )
    },

    dismissQuestions: async (questionId) => {
      await throughIpc(() => commands.agentDismissQuestions({ questionId }))
    },
  }
}
