/**
 * 帧到条目的唯一入口。
 *
 * 它拥有一轮的公共部分：怎么开始、怎么结束、结局怎么读、那一问怎么落账，以及
 * 审批 —— 审批帧读的是 kap 自己的答复词汇（requestId / decision / scope）。
 * 方言只有一种，归 kap-projection。
 *
 * 它只往草稿上写，既不开草稿也不封版（见 timeline-draft），所以「纯、总、可重放」
 * 那三条性质与它无关：那是 timeline-reducer 的承诺。
 */

import type { KapStopReason, RunEvent, RunStatus } from '@poietica/agent-contract'
import { applyKapFrame } from './kap-projection'
import type {
  LinkTimelineItem,
  MessageImage,
  PermissionItem,
  QuestionTimelineItem,
} from './timeline-contract'
import type { Draft } from './timeline-draft'
import {
  beginQuestion,
  markFrame,
  markTurnEnd,
  markTurnStart,
  namespace,
  positionOf,
  push,
  pushFailure,
  sealTail,
  takeQueued,
} from './timeline-draft'
import { pendingPermission, pendingQuestion } from './timeline-queries'

/**
 * 这一帧一定会被丢掉吗。
 *
 * 这不是一道闸门，是一次保守的预判：为真时 apply 一定丢，为假时什么都不承诺。
 * 它唯一的作用是让一整批全是重复帧的输入不必开草稿 —— 引用原样交回，下游的记忆
 * 化不会被白白打掉。真正的去重只有 apply 里那一处，就在下面。
 *
 * run_started 不预判：它开的那一段窗口马上要重来（beginRun），拿上一段的窗口去
 * 判它，判出来的重复是假的。
 *
 * 它住在这里而不住在调用方，是因为它逼近的那条判据在这里 —— 一份权威，一份贴着
 * 权威写的近似，中间没有可以各自漂移的余地。
 */
export function surelyIgnored(event: RunEvent, lastSeq: number): boolean {
  return event.kind !== 'run_started' && event.seq <= lastSeq
}

export function apply(draft: Draft, event: RunEvent): void {
  /*
   * 段的边界不在这里判。
   *
   * 一帧 run_started 可能是新的一轮，也可能是同一份日志被重放了一遍，而这两者的
   * seq、at、prompt 全都一样：apply 手上没有任何东西能把它们分开。所以由知道自己
   * 在干什么的那一层来开段 —— 人先说话时是 appendUserMessage，没有经过输入框的那
   * 些轮次是 beginRun，而 replayRunEvents 一轮到底、一段都不开：同一份日志放两遍
   * 必须得到同一个状态，这是回放能被信任的前提。
   *
   * 去重只有下面这一处。正因为一段都不开的那条路径上没有第二张网，这里不能跟着
   * surelyIgnored 一起给 run_started 放行 —— 放行之后紧跟着的那句赋值会把窗口拨
   * 回到它的 seq，后面每一帧都会重新生效一遍。
   */
  if (event.seq <= draft.lastSeq) {
    return
  }

  draft.lastSeq = event.seq
  /* 这一轮的存活证据。耗时的终点取它，两端因此同在日志域。 */
  markFrame(draft, event.at)

  switch (event.kind) {
    case 'run_started': {
      draft.status = 'submitted'
      /* 起点是这一帧的时刻，不是本机此刻：回放要复现同一个耗时。 */
      markTurnStart(draft, event.at)
      withPrompt(draft, event)

      return
    }

    case 'permission_requested': {
      draft.status = 'awaiting_permission'

      push(draft, {
        type: 'permission',
        id: `${namespace(draft)}permission-${event.requestId}`,
        turn: draft.runIndex,
        at: event.at,
        requestId: event.requestId,
        title: event.title,
        /* 缺席和「值为 undefined」在 exactOptionalPropertyTypes 下不是一回事。 */
        ...(event.toolCall === undefined ? {} : { toolCall: event.toolCall }),
      })

      return
    }

    case 'permission_resolved': {
      settlePermission(draft, `${namespace(draft)}permission-${event.requestId}`, {
        decision: event.decision,
        ...(event.scope === undefined ? {} : { scope: event.scope }),
      })

      /* 答掉一个不等于不再等：并行的子代理会同时挂着几个请求。第一个答复一到
         就写 running，界面会说这一轮不在等人了，而另外几个请求还挂在原生侧的
         桌子上。这句话必须排在上面那次落账之后：刚答掉的这一个也在扫描范围里。 */
      draft.status = stillWaiting(draft)

      return
    }

    case 'questions_asked': {
      push(draft, {
        type: 'question',
        id: `${namespace(draft)}question-${event.questionId}`,
        turn: draft.runIndex,
        at: event.at,
        questionId: event.questionId,
        /* 缺席和「值为 undefined」在 exactOptionalPropertyTypes 下不是一回事。 */
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        questions: event.questions,
      })

      /* 与审批同一条规矩：先落账，再问还有谁在等 —— 刚到的这一组也在扫描范围里。 */
      draft.status = stillWaiting(draft)

      return
    }

    case 'questions_resolved': {
      settleQuestion(draft, `${namespace(draft)}question-${event.questionId}`, {
        outcome: event.outcome,
        answers: event.answers,
        note: event.note,
      })

      draft.status = stillWaiting(draft)

      return
    }

    case 'kap_event': {
      applyKapFrame(draft, event)

      return
    }

    /* 一次断线在屏幕上只占一行：它就地改写，所以那一行留在它第一次出现的位置。 */
    case 'link_changed': {
      const id = `${namespace(draft)}link`
      const position = positionOf(draft, id)
      const held = position < 0 ? undefined : draft.items[position]
      const shown: LinkTimelineItem = {
        type: 'link',
        id,
        turn: draft.runIndex,
        at: event.at,
        link: event.link,
      }

      if (held?.type === 'link') {
        draft.items[position] = shown
      } else {
        push(draft, shown)
      }

      return
    }

    case 'run_finished': {
      sealTail(draft)
      /* 这一帧只收状态：用户可见的失败统一由 pushFailure 落账。 */
      draft.status = finalStatus(event.stopReason)
      markTurnEnd(draft, event.at)

      return
    }

    case 'run_failed': {
      sealTail(draft)
      draft.status = 'failed'
      markTurnEnd(draft, event.at)
      pushFailure(draft, {
        type: 'error',
        id: `${namespace(draft)}error-${String(event.seq)}`,
        turn: draft.runIndex,
        at: event.at,
        message: preferAgent(event.message, event.diagnostics),
      })

      return
    }
  }
}

/**
 * 日志里录下的那一问。
 *
 * 一问由这一帧带全：文字与图片地址都在 run_started 上（见 frame.rs 的
 * RunStarted）。人经输入框提交的那些轮次先落一条乐观条目，图在这里补上去；没
 * 经过输入框的那些轮次（自动化、重连续接）整条都由这里落。两条路都只从这一帧
 * 取图，所以「哪张图属于哪一句话」在这个程序里只有一个答案。
 *
 * 判据是「本段末尾已经是一问」，不是文本相等：同一句话在两轮里说两遍是常事，
 * 而两轮不会是同一段。
 */
function withPrompt(
  draft: Draft,
  event: {
    readonly seq: number
    readonly at: number
    readonly prompt?: string | undefined
    readonly images?: readonly string[] | undefined
    readonly skills?: readonly string[] | undefined
  },
): void {
  /* 缺席与空串在这里是同一件事：都表示这一帧没有带来一句要显示的话。
     旁白要剥掉：这一格由 driver 填，agent CLI 会往里注入自己的话（见 saidByUser）。 */
  const prompt = saidByUser(event.prompt ?? '')
  const shown: readonly MessageImage[] = (event.images ?? []).map((url) => ({ url }))
  const attached: readonly string[] = event.skills ?? []

  /* 只挑了图、只挂了记号，仍然是一句说过的话。 */
  if (prompt.length === 0 && shown.length === 0 && attached.length === 0) {
    return
  }

  if (adoptQueuedPrompt(draft, prompt, shown, attached) || dressTail(draft, shown, attached)) {
    return
  }

  beginQuestion(draft)

  push(draft, {
    type: 'user_message',
    id: `${namespace(draft)}said-${String(event.seq)}`,
    turn: draft.runIndex,
    at: event.at,
    text: prompt,
    /* 缺席和「值为 undefined」在 exactOptionalPropertyTypes 下不是一回事。 */
    ...(shown.length === 0 ? {} : { images: shown }),
    ...(attached.length === 0 ? {} : { skills: attached }),
  })
}

/**
 * 本段末尾那一问，补上这一帧带来的图。
 *
 * 那一条是人按下发送时本机落的（appendUserMessage）：那一刻字节还没落盘，也就
 * 还没有地址。所以地址在这里补，而不是另开一条从 IPC 答复回来的路。
 *
 * O(1)，因为一问永远是它自己那一段的开头。
 */
function dressTail(
  draft: Draft,
  shown: readonly MessageImage[],
  attached: readonly string[],
): boolean {
  const position = draft.items.length - 1
  const tail = draft.items[position]

  if (tail?.type !== 'user_message' || tail.turn !== draft.runIndex) {
    return false
  }

  if (shown.length > 0 || attached.length > 0) {
    draft.items[position] = {
      ...tail,
      ...(shown.length === 0 ? {} : { images: shown }),
      ...(attached.length === 0 ? {} : { skills: attached }),
    }
  }

  return true
}

/**
 * 认领上一段末尾那条排队提问。
 *
 * 文字逐字相等才认：同一句话在两轮里说两遍是常事，而两轮不会是同一段。认领之后它
 * 落在这一段的开头，与自己的答复相邻。
 */
function adoptQueuedPrompt(
  draft: Draft,
  prompt: string,
  shown: readonly MessageImage[],
  attached: readonly string[],
): boolean {
  const queued = takeQueued(draft, prompt)

  if (queued === undefined) {
    return false
  }

  beginQuestion(draft)
  push(draft, {
    ...queued,
    id: `${namespace(draft)}said-${String(draft.lastSeq)}`,
    turn: draft.runIndex,
    ...(shown.length === 0 ? {} : { images: shown }),
    ...(attached.length === 0 ? {} : { skills: attached }),
  })

  return true
}

/** Transport context and process diagnostics describe different layers; keep both. */
function preferAgent(message: string, diagnostics?: string): string {
  const said = diagnostics?.trim() ?? ''
  const ours = message.trim()

  if (said.length === 0) {
    return message
  }

  return ours.length === 0 || said.includes(ours) ? said : `${message}\n${said}`
}

/**
 * 落一次答复：请求的身份算得出来，所以按 id 定位，只补 resolution。
 *
 * 两支各自成形，因为答复的形状不同：审批记 kap 的 decision 与 scope，提问记
 * outcome、answers 与 note。定位那一步共用 positionOf。
 */
function settlePermission(
  draft: Draft,
  id: string,
  resolution: NonNullable<PermissionItem['resolution']>,
): void {
  const position = positionOf(draft, id)
  const asked = position < 0 ? undefined : draft.items[position]

  if (asked?.type === 'permission') {
    draft.items[position] = { ...asked, resolution }
  }
}

function settleQuestion(
  draft: Draft,
  id: string,
  resolution: NonNullable<QuestionTimelineItem['resolution']>,
): void {
  const position = positionOf(draft, id)
  const asked = position < 0 ? undefined : draft.items[position]

  if (asked?.type === 'question') {
    draft.items[position] = { ...asked, resolution }
  }
}

/**
 * 这一轮还在等谁。
 *
 * 两条队列一张嘴：审批与提问可以同时挂着，而 status 只有一个词。审批压过提问
 * （与上游 phase 的派生优先级一致），都不在等才是 running。判据只有这一份 ——
 * 请求到达与答复到达的两支都读它，抄成两份就会有两种「还在等」。
 */
function stillWaiting(draft: Draft): RunStatus {
  if (pendingPermission(draft) !== undefined) {
    return 'awaiting_permission'
  }

  return pendingQuestion(draft) === undefined ? 'running' : 'awaiting_question'
}

function finalStatus(stopReason: KapStopReason): RunStatus {
  switch (stopReason) {
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
    case 'blocked':
      return 'failed'
  }
}

/**
 * 用户这一句里，哪些字是用户自己说的。
 *
 * agent CLI 会往这一轮的用户消息里注入自己的旁白 —— 观察到的一例：只发了一张
 * 图，回放出来却是「一张图 + 一段 <system-reminder>，告诉模型这张图被压过、原图
 * 在哪个路径」。那段字不是人说的，把它当成人说的话显示出来，转录就在撒谎。
 *
 * 剥的是标记之间的整块，不按关键词猜；跨行也吃 —— 那段旁白本来就是多行的。剥完
 * 为空时这条消息仍然留着：一句纯图片的话，屏幕上正是靠这一格站住的。
 */
const INJECTED = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function saidByUser(text: string): string {
  return text.replace(INJECTED, '').trim()
}
