import type { InteractionAnswer, QueueSnapshot } from '@poietica/engine'
import { createId } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import type { ApprovalAnswer } from '../agent/permission'
import type { PlanAnswer } from '../agent/plan'
import type { QuestionResponse } from '../agent/question'
import type { AgentSessionPort, DeliveryModePatch, QueuedMessages, WithdrawnMessage } from '../agent/session'
import type { TranscriptCatchUp, TranscriptPage, TranscriptSignal } from '../agent/transcript'
import type { ConversationApi } from '../api'
import { GOAL_CONTROL_ID, GOAL_ENABLED } from '../components/goal/goal-control'

/*
 * 会话端口：legacy 的 \`AgentSessionPort\` 落在 conversation 契约的 RPC 上。
 *
 * legacy 里这一层由 preload 暴露的 IPC 桥提供（\`apps/desktop/src/**\` 的 agent-client）；
 * 新架构里它就是 conversation 契约的 \`threads.*\` / \`turns.*\` / \`timeline.*\` / \`queue.*\` /
 * \`interactions.*\` 六个命名空间（05 页 §11.4）。**端口形状一字未改** —— 组件与转录 store
 * 因此完全不用动，这正是 14 页 §0.3 第 1 条说的「只改依赖方向和数据来源」。
 *
 * 三处语义映射写在这里（不是在组件里散着）：
 *   1. **epoch**：legacy 的 \`catchUpTranscript\` 只带 seq；新协议的 \`timeline.catchUp\` 还要
 *      epoch（05 页 §12.2）。epoch 由本层记住（订阅与整读时更新），记不住就交回
 *      \`complete: false\`，下游据此整读重建 —— 与协议里那条兜底同义。
 *   2. **promptId**：legacy 的 prompt 交回 agent 签的 promptId；新协议里 UI 自己生成
 *      \`clientTurnId\`（05 页 §12.2），Core 把它写进 \`turn.upsert\`。所以这里交回 clientTurnId：
 *      它是「这一句」的身份，与 legacy 的 promptId 同用。
 *   3. **撤回 / 换层**：契约按 itemId 点名（R-01 §3.8）。这里先从最新快照里找到那一项
 *      （找不到返回 null），再把号交给 \`queue.withdraw\`；换层走 \`queue.move\`，附件与
 *      技能由 Core 用账本里的原始输入重投，UI 不再「撤回 + 重新提交」。
 */

/** 花名册：task 表里有号的那些（子 agent 的号由 omp 签，transcript 的 task 带着它） */
function rosterOf(
  tasks: readonly { readonly agentId?: string | undefined }[],
): readonly { readonly agentId: string; readonly name: string }[] {
  return tasks.flatMap((task) => (task.agentId === undefined ? [] : [{ agentId: task.agentId, name: task.agentId }]))
}

/**
 * 队列快照 → legacy 的 QueuedMessages（字段一一对应）。
 *
 * `threadId` 是**这条对话自己的号**，不是队列里那几条 item 的号。
 * 原先这里填的是 `snapshot.items[0]?.id`（legacy 认领队列用的是资产会话号），
 * 空队列时它为 `''`、非空时它是随手挑的一条消息号 —— 两个都不是对话号，
 * 下游按它找转录音频格永远找不着（真实故障：队列 chip 永不更新）。
 */
function toQueued(threadId: string, snapshot: QueueSnapshot): QueuedMessages {
  return {
    threadId,
    steering: snapshot.items.filter((i) => i.deliverAs === 'steer').map((i) => ({ id: i.id, text: i.text })),
    followUp: snapshot.items.filter((i) => i.deliverAs === 'followUp').map((i) => ({ id: i.id, text: i.text })),
    steeringMode: snapshot.modes.steer,
    followUpMode: snapshot.modes.followUp,
    interruptMode: 'immediate',
  }
}

export interface SessionPortOptions {
  readonly api: ConversationApi
  readonly threadId: string
  /**
   * 快照里的「提交行」到手时交给它（方案第 5 节：「每个线程一个 submissions 存储，
   * 三个来源：订阅快照、通知、submit 回复」）。缺席即这一路没人收，只影响回显。
   */
  readonly onSubmissions?: ((rows: readonly import('../../contract').SubmissionView[]) => void) | undefined
}

export function createSessionPort({ api, threadId, onSubmissions }: SessionPortOptions): AgentSessionPort {
  /** agentId → 最近一次见到的 epoch（第 1 条映射） */
  const epochs = new Map<string, number>()

  const transcript = {
    subscribeTranscript(listener: (signal: TranscriptSignal) => void): () => void {
      const offOps = api.onTimelineOps((p) => {
        if (p.threadId !== threadId) return
        epochs.set(p.agentId, p.epoch)
        listener({
          kind: 'ops',
          sessionId: p.threadId,
          agentId: p.agentId,
          seq: p.seq,
          ops: p.ops as readonly TranscriptOperation[],
        })
      })
      const offReset = api.onTimelineReset((p) => {
        if (p.threadId !== threadId) return
        epochs.set(p.agentId, p.epoch)
        listener({ kind: 'reset', sessionId: p.threadId, agentId: p.agentId, seq: undefined })
      })
      return () => {
        offOps.dispose()
        offReset.dispose()
      }
    },

    async readTranscript(sessionId: string, agentId: string, beforeTurn?: string): Promise<TranscriptPage> {
      const target = sessionId === '' ? threadId : sessionId
      if (beforeTurn !== undefined) {
        const older = await api.timelinePage(target, agentId, beforeTurn)
        return {
          ...older,
          agentId,
          agents: rosterOf(older.tasks),
          pendingInteractions: older.interactions.filter((i) => i.state === 'pending').map((i) => i.interactionId),
          seq: epochs.get(agentId) ?? 0,
        }
      }
      // 整读：先取位置、再取整页（05 页 §12.2 的快照约定），所以 seq 用它交回的那个
      const snap = await api.subscribeTimeline(target, agentId)
      epochs.set(agentId, snap.epoch)
      onSubmissions?.(snap.submissions)
      return {
        ...snap.page,
        agentId,
        agents: rosterOf(snap.page.tasks),
        pendingInteractions: snap.page.interactions.filter((i) => i.state === 'pending').map((i) => i.interactionId),
        seq: snap.seq,
      }
    },

    async catchUpTranscript(sessionId: string, agentId: string, sinceSeq: number): Promise<TranscriptCatchUp> {
      const target = sessionId === '' ? threadId : sessionId
      const epoch = epochs.get(agentId)
      // epoch 没记住：交回不完整，下游整读重建（第 1 条映射）
      if (epoch === undefined) {
        return { agentId, batches: [], latestSeq: sinceSeq, complete: false }
      }
      const r = await api.catchUp(target, agentId, epoch, sinceSeq)
      return { agentId, batches: r.batches, latestSeq: r.latestSeq, complete: r.complete }
    },
  }

  const queue = async (): Promise<QueueSnapshot> => api.getQueue(threadId)

  return {
    transcript,

    async prompt(request) {
      /* 号由调用方铸（快照与提交行靠它认成同一条）；没给才现铸一个。 */
      const clientTurnId = request.clientTurnId ?? createId()
      /*
       * 目标「发送时生效」（产品负责人 2026-10-07 定稿；legacy 的 appliesOnSubmit 同义）：
       * 人打开目标开关时只改了本地那一格，正文（这一句）此刻才拿得到。所以在**提交之前**
       * 用这一句的正文把目标设下去，再发这一轮 —— 顺序反了模型会先按普通一轮开跑。
       *
       * 关掉目标（`to:'off'`）是立即生效的：那一支走 `setGoal(threadId, null)`，
       * 由 UI 在点的那一下直接发，不经过这里。
       */
      const goalConfig = request.configuration.find((entry) => entry.id === GOAL_CONTROL_ID)
      if (goalConfig?.value === GOAL_ENABLED) {
        await api.setGoal(request.threadId === '' ? threadId : request.threadId, request.text)
      }
      const submission = await api.submit({
        threadId: request.threadId === '' ? threadId : request.threadId,
        clientTurnId,
        text: request.text,
        /*
         * legacy 的 assets 是原生侧签的资产令牌；新架构里附件走 attachments 契约的 id
         * —— PromptInput 把 DraftAttachment.id 装进 ComposerAsset.assetToken，所以这里
         * 原样交回那批 id：Core 侧走 attachments.resolve/retain（07 页 §5D 第 2 条）。
         */
        attachmentIds: request.assets.map((asset) => asset.assetToken),
        skills: request.skills.map((skill) => (skill.args === undefined ? skill.name : `${skill.name} ${skill.args}`)),
        deliverAs: request.deliverAs,
      })
      // 第 2 条映射：legacy 的 promptId → 新协议的 clientTurnId
      return { sessionId: threadId, promptId: clientTurnId, submission }
    },

    async cancel(target) {
      await api.cancelTurn(target === '' ? threadId : target)
    },

    async readQueue() {
      return toQueued(threadId, await queue())
    },

    async withdraw(itemId: string): Promise<WithdrawnMessage | null> {
      const snapshot = await queue()
      const item = snapshot.items.find((i) => i.id === itemId)
      if (item === undefined) return null
      await api.withdraw(threadId, itemId)
      return { text: item.text }
    },

    async move(itemId: string, deliverAs: 'steer' | 'followUp'): Promise<QueuedMessages> {
      return toQueued(threadId, await api.move(threadId, itemId, deliverAs))
    },

    async setDeliveryModes(patch: DeliveryModePatch) {
      const next = await api.setQueueModes(threadId, {
        ...(patch.steeringMode === undefined ? {} : { steer: patch.steeringMode }),
        ...(patch.followUpMode === undefined ? {} : { followUp: patch.followUpMode }),
      })
      return toQueued(threadId, next)
    },

    subscribeQueue(listener) {
      return api.onQueueChanged((p) => {
        if (p.threadId !== threadId) return
        listener(toQueued(threadId, p.queue))
      }).dispose
    },

    subscribePromptDropped(listener) {
      return api.onTurnDropped((p) => {
        if (p.threadId !== threadId) return
        listener({ threadId, text: p.text })
      }).dispose
    },

    subscribeRunFailed(listener) {
      /*
       * Core 侧的「这一轮结束了」在 turns.state（`turns.state` 通知）；掉线由内核的
       * CoreStatus 报，订阅它要在装配层接（那里才拿得到 CoreStatusToken）。
       * 这一条留给那一处接线，端口这层不编造第二个失败来源。
       */
      void listener
      return () => undefined
    },

    async abortPrompt(target, promptId) {
      void promptId
      await api.cancelTurn(target === '' ? threadId : target)
    },

    async resolvePermission(requestId, answer: ApprovalAnswer) {
      // legacy 的 approved/rejected → engine 的 approve/reject（04 页 §2.2 的 InteractionAnswer）
      const a: InteractionAnswer = {
        kind: 'approval',
        decision: answer.decision === 'approved' ? 'approve' : 'reject',
        scope: answer.scope === 'session' ? 'session' : 'once',
        feedback: answer.feedback ?? null,
      }
      await api.respond(threadId, requestId, a)
    },

    /*
     * 计划卡片的三档答复（04 页 §3.12 第 5 支）：答复形状就是引擎那一支，不换算 ——
     * 卡片的按钮直接产出 `{kind:'plan', decision, feedback}`（ui/agent/plan.ts）。
     */
    async resolvePlan(requestId, answer: PlanAnswer) {
      await api.respond(threadId, requestId, answer)
    },

    async answerQuestions(response: QuestionResponse) {
      // legacy 一题一答，且题号是桥签的；新协议里交互 id 就是那一个号
      const first = response.answers[0]
      const answers: Record<string, { selected: string[]; custom: string | null }> = {}
      if (first !== undefined) {
        const choice = first.answer
        answers[response.questionId] = {
          selected:
            choice.kind === 'single'
              ? [choice.optionId]
              : choice.kind === 'multi'
                ? [...choice.optionIds]
                : choice.kind === 'multi_with_other'
                  ? [...choice.optionIds]
                  : [],
          custom: choice.kind === 'other' ? choice.text : choice.kind === 'multi_with_other' ? choice.otherText : null,
        }
      }
      await api.respond(threadId, response.questionId, { kind: 'question', answers })
    },

    async dismissQuestions(questionId) {
      await api.respond(threadId, questionId, { kind: 'dismiss' })
    },
  }
}
