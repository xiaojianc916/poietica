import {
  type AgentQuestionChoice,
  type AgentTranscriptEvent,
  commands,
  events,
} from '@poietica/contract'
import type { AgentSessionPort, QuestionChoice, TranscriptCatchUp } from '@poietica/conversation'
import { transcriptOpsCatchupResponseSchema } from '@poietica/transcript'
import { throughIpc } from '../ipc-error'
import { type AgentEventSourceOptions, subscribeToEvent } from './event-subscription'
import type { AgentBridgeOptions } from './launch-contract'
import { decodeTranscriptEvent, transcriptPageOf } from './transcript-decoding'

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
  launch,
  cwd,
  onListenFailure,
}: AgentBridgeOptions & AgentEventSourceOptions): AgentSessionPort {
  return {
    transcript: {
      subscribeTranscript: (listener) =>
        subscribeToEvent<AgentTranscriptEvent>(
          (receive) => events.agentTranscriptEvent.listen((event) => receive(event.payload)),
          (wire) => {
            const decoded = decodeTranscriptEvent(wire)
            if (decoded.ok) {
              listener(decoded.signal)
              return
            }
            onListenFailure?.(decoded.error)
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
        const data = transcriptOpsCatchupResponseSchema.parse(JSON.parse(wire.json))
        return {
          agentId: data.agent_id,
          batches: data.batches,
          latestSeq: data.latest_seq,
          complete: data.complete,
        } as TranscriptCatchUp
      },
    },
    prompt: async (request) => {
      const resolvedLaunch = await launch()
      const started = await throughIpc(() =>
        commands.agentPrompt({
          text: request.text,
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
          })),
          launch: resolvedLaunch,
          cwd: cwd?.() ?? null,
        }),
      )

      return started
    },

    cancel: async (threadId) => {
      await throughIpc(() => commands.agentCancel({ threadId }))
    },

    steer: async (threadId, promptIds) => {
      /* readonly 数组与生成绑定要的可变数组是两个类型，所以复制一次。 */
      await throughIpc(() => commands.agentSteer({ threadId, promptIds: [...promptIds] }))
    },

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
