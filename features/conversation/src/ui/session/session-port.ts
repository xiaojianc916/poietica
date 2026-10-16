import type { InteractionAnswer, QueueSnapshot } from '@poietica/engine'
import { createId } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import type { ConversationApi } from '../api'
import { GOAL_CONTROL_ID, GOAL_ENABLED } from '../shared/model/goal-control'
import type { ApprovalAnswer } from '../shared/model/permission'
import type { PlanAnswer } from '../shared/model/plan'
import type { QuestionResponse } from '../shared/model/question'
import type { AgentSessionPort, DeliveryModePatch, QueuedMessages, WithdrawnMessage } from '../shared/model/session'
import type { TranscriptCatchUp, TranscriptPage, TranscriptSignal } from '../shared/model/transcript'

/*
 * 把 AgentSessionPort 架在 conversation 契约的 RPC 上（`threads.*` / `turns.*` / `timeline.*` / `queue.*` / `interactions.*`）。
 * **端口形状照 legacy 一字未改** —— 组件与转录 store 因此完全不用动。三处语义映射写在这里：
 *   1. **epoch**：`catchUpTranscript` 只带 seq，`timeline.catchUp` 还要 epoch（本层记住）；记不住就交回 `complete: false`，下游整读重建。
 *   2. **promptId**：UI 自己生成 `clientTurnId`，这里交回它 —— 它是「这一句」的身份。
 *   3. **撤回 / 换层**：契约按 itemId 点名，先从最新快照里找到那一项（找不到返回 null）；换层走 `queue.move`，附件与技能由 Core 重投。
 */

/** 花名册：task 表里有号的那些（子 agent 的号由 omp 签）。 */
function rosterOf(
  tasks: readonly { readonly agentId?: string | undefined }[],
): readonly { readonly agentId: string; readonly name: string }[] {
  return tasks.flatMap((task) => (task.agentId === undefined ? [] : [{ agentId: task.agentId, name: task.agentId }]))
}

/**
 * `threadId` 是**这条对话自己的号**，不是队列里那几条 item 的号：填 `snapshot.items[0]?.id` 时它空队列为 `''`、
 * 非空为随手挑的一条消息号，下游按它找转录永远找不着（真实故障：队列 chip 永不更新）。
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
  /** 快照里的「提交行」到手时交给它；缺席即这一路没人收，只影响回显。 */
  readonly onSubmissions?: ((rows: readonly import('../../contract').SubmissionView[]) => void) | undefined
}

export function createSessionPort({ api, threadId, onSubmissions }: SessionPortOptions): AgentSessionPort {
  /**
   * agentId → 端口最近一次见到的 (epoch, seq)。**epoch** 是换代判据：Core 重启后新进程的 epoch 与旧的不同，
   * 端口一旦发现变化就必须让副本整读而不是当增量交下去（新进程的 seq 从 1 重来，当增量只会被旧水位判成重复）。
   * **seq** 是这一代的水位：旧页整读（`beforeTurn`）要带真实水位回来（原先这里填的是 epoch，翻页后必崩）。
   */
  const positions = new Map<string, { readonly epoch: number; readonly seq: number }>()

  const transcript = {
    subscribeTranscript(listener: (signal: TranscriptSignal) => void): () => void {
      const offOps = api.onTimelineOps((p) => {
        if (p.threadId !== threadId) return
        const known = positions.get(p.agentId)
        positions.set(p.agentId, { epoch: p.epoch, seq: p.seq })
        if (known !== undefined && known.epoch !== p.epoch) {
          /* 换代（Core 重启、或我们错过了 reset）：这一批不能当增量用，让副本整读。丢掉它不丢数据 —— 整读的快照位置在这批之后。 */
          listener({ kind: 'reset', sessionId: p.threadId, agentId: p.agentId, seq: undefined })
          return
        }
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
        positions.set(p.agentId, { epoch: p.epoch, seq: 0 })
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
          /* 旧页带**真实 seq**：副本的游标不变式认的是水位。 */
          seq: positions.get(agentId)?.seq ?? 0,
        }
      }
      // 整读：先取位置、再取整页。
      const snap = await api.subscribeTimeline(target, agentId)
      positions.set(agentId, { epoch: snap.epoch, seq: snap.seq })
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
      const position = positions.get(agentId)
      // epoch 没记住：交回不完整，下游整读重建。
      if (position === undefined) {
        return { agentId, batches: [], latestSeq: sinceSeq, complete: false }
      }
      const r = await api.catchUp(target, agentId, position.epoch, sinceSeq)
      return { agentId, batches: r.batches, latestSeq: r.latestSeq, complete: r.complete }
    },
  }

  const queue = async (): Promise<QueueSnapshot> => api.getQueue(threadId)

  return {
    transcript,

    async prompt(request) {
      /* 号由调用方铸（快照与提交行靠它认成同一条）。 */
      const clientTurnId = request.clientTurnId ?? createId()
      /*
       * 目标「发送时生效」：人打开目标开关时只改了本地那一格，正文（这一句）此刻才拿得到。所以在**提交之前**用这一句的正文把目标设下去 ——
       * 顺序反了模型会先按普通一轮开跑。关掉目标（`to:'off'`）是立即生效的，不经过这里。
       */
      const goalConfig = request.configuration.find((entry) => entry.id === GOAL_CONTROL_ID)
      if (goalConfig?.value === GOAL_ENABLED) {
        await api.setGoal(request.threadId === '' ? threadId : request.threadId, request.text)
      }
      const submission = await api.submit({
        threadId: request.threadId === '' ? threadId : request.threadId,
        clientTurnId,
        text: request.text,
        /* 附件走 attachments 契约的 id：PromptInput 把 DraftAttachment.id 装进 ComposerAsset.assetToken，这里原样交回那批 id，Core 侧走 attachments.resolve/retain。 */
        attachmentIds: request.assets.map((asset) => asset.assetToken),
        skills: request.skills.map((skill) => (skill.args === undefined ? skill.name : `${skill.name} ${skill.args}`)),
        deliverAs: request.deliverAs,
      })
      // 第 2 条映射：promptId → clientTurnId。
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
      /* 「这一轮结束了」在 turns.state 通知里；掉线由内核的 CoreStatus 报，接线在装配层。这一层不编造第二个失败来源。 */
      void listener
      return () => undefined
    },

    async abortPrompt(target, promptId) {
      void promptId
      await api.cancelTurn(target === '' ? threadId : target)
    },

    async resolvePermission(requestId, answer: ApprovalAnswer) {
      // 引擎那一侧叫 approve/reject，别按字面找。
      const a: InteractionAnswer = {
        kind: 'approval',
        decision: answer.decision === 'approved' ? 'approve' : 'reject',
        scope: answer.scope === 'session' ? 'session' : 'once',
        feedback: answer.feedback ?? null,
      }
      await api.respond(threadId, requestId, a)
    },

    /* 答复形状就是引擎那一支，不换算 —— 卡片的按钮直接产出 `{kind:'plan', decision, feedback}`。 */
    async resolvePlan(requestId, answer: PlanAnswer) {
      await api.respond(threadId, requestId, answer)
    },

    async answerQuestions(response: QuestionResponse) {
      /*
       * 交互号是这一组的号，题号是引擎签的、一组可以有好几道 —— 答复按**题号**一道一道回去。
       * 从前只回第一道、还按交互号作键，引擎按题号对不上，整组被读成「用户取消」（Q1-C）。
       */
      const answers: Record<string, { selected: string[]; custom: string | null }> = {}
      for (const { questionId, answer } of response.answers) {
        answers[questionId] = {
          selected:
            answer.kind === 'single'
              ? [answer.optionId]
              : answer.kind === 'multi' || answer.kind === 'multi_with_other'
                ? [...answer.optionIds]
                : [],
          custom: answer.kind === 'other' ? answer.text : answer.kind === 'multi_with_other' ? answer.otherText : null,
        }
      }
      await api.respond(threadId, response.questionId, { kind: 'question', answers })
    },

    /* 答复形状就是引擎那一支（同 resolvePlan）：从前一律答成 approval，broker 按种类对不上就拒收（Q1-E）。 */
    async answerDialog(interactionId, answer) {
      await api.respond(threadId, interactionId, answer)
    },

    async dismissQuestions(questionId) {
      await api.respond(threadId, questionId, { kind: 'dismiss' })
    },
  }
}
