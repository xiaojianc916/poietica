/**
 * 帧到条目的唯一入口。
 *
 * 它拥有两条线共有的那部分：一轮怎么开始、怎么结束、结局怎么读，以及那一问怎么
 * 落账。方言只有两格 —— ACP 的会话通知与授权请求归 acp-projection，harness 的
 * 会话日志信封归 harness-projection —— 分派在这里发生，所以两条方言互不知情。
 *
 * 它只往草稿上写，既不开草稿也不封版（见 timeline-draft），所以「纯、总、可重放」
 * 那三条性质与它无关：那是 timeline-reducer 的承诺。
 */

import type { AcpStopReason, RunEvent, RunStatus } from '@poietica/agent-contract'
import { applyAcpFrame, saidByUser } from './acp-projection'
import { applyHarnessFrame } from './harness-projection'
import { isRenderable } from './renderable'
import type { MessageImage, UserMessageItem } from './timeline-contract'
import type { Draft } from './timeline-draft'
import {
  beginQuestion,
  markTurnEnd,
  markTurnStart,
  namespace,
  push,
  sealTail,
} from './timeline-draft'

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

  switch (event.kind) {
    case 'run_started': {
      draft.status = 'running'
      /* 起点是这一帧的时刻，不是本机此刻：回放要复现同一个耗时。 */
      markTurnStart(draft, event.at)
      withPrompt(draft, event)

      return
    }

    case 'acp_update':
    case 'permission_requested':
    case 'permission_resolved': {
      applyAcpFrame(draft, event)

      return
    }

    case 'harness_event': {
      applyHarnessFrame(draft, event)

      return
    }

    case 'run_finished': {
      /* A turn can end on the agent terms and still be a failure: a rejected
         provider request is reported by the agent itself, outside the
         protocol, and the stop reason stays ordinary. When it left such an
         account, that account is the entry, and our own wording never
         appears at all. */
      sealTail(draft)
      /* 一轮的结局是一轮的事实，不是它发起的每一次调用的事实。没等到终态的
         调用就停在它最后被报到的地方：status 装的是协议值，也就是 agent 说过
         的话，这一层没有资格替它补一句「失败」。停住的纺锤怎么画，归读模型。 */
      draft.status = finalStatus(event.stopReason)
      markTurnEnd(draft, event.at)

      const said = event.diagnostics?.trim() ?? ''
      const told = said.length > 0 ? said : silentTurn(draft, event.stopReason)

      if (told !== undefined) {
        push(draft, {
          type: 'error',
          id: `${namespace(draft)}agent-${String(event.seq)}`,
          turn: draft.runIndex,
          at: event.at,
          message: told,
        })
      }

      return
    }

    case 'run_failed': {
      sealTail(draft)
      draft.status = 'failed'
      markTurnEnd(draft, event.at)
      push(draft, {
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
  },
): void {
  /* 缺席与空串在这里是同一件事：都表示这一帧没有带来一句要显示的话。
     清洗规则借的是 ACP 那条线的：这一格的内容由各自的 driver 填，而 ACP 那侧
     填的是协议请求里的内容，agent CLI 会往里注入自己的旁白（见 saidByUser）。
     所以它是一条方言事实，住在方言那个文件里；harness 那条线上它是空操作。 */
  const prompt = saidByUser(event.prompt ?? '')
  const shown: readonly MessageImage[] = (event.images ?? []).map((url) => ({ url }))

  /* 只挑了图、没打字，仍然是一句说过的话。 */
  if (prompt.length === 0 && shown.length === 0) {
    return
  }

  if (adoptQueuedPrompt(draft, prompt, shown) || dressTail(draft, shown)) {
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
function dressTail(draft: Draft, shown: readonly MessageImage[]): boolean {
  const position = draft.items.length - 1
  const tail = draft.items[position]

  if (tail?.type !== 'user_message' || tail.turn !== draft.runIndex) {
    return false
  }

  if (shown.length > 0) {
    draft.items[position] = { ...tail, images: shown }
  }

  return true
}

/**
 * Claims a question queued while the preceding run was still producing output.
 *
 * That local message deliberately keeps the old turn until run_started opens
 * the next sequence window. Once the frame arrives, matching the exact prompt
 * is safe: only local messages from the immediately preceding turn are
 * candidates, and the newest unmatched one wins.
 */
function adoptQueuedPrompt(draft: Draft, prompt: string, shown: readonly MessageImage[]): boolean {
  for (let position = draft.items.length - 1; position >= 0; position--) {
    const item = draft.items[position]

    if (item?.type !== 'user_message' || !item.id.includes('local-said-')) {
      continue
    }
    if (item.turn >= draft.runIndex || item.text !== prompt) {
      return false
    }

    const adopted: UserMessageItem = {
      ...item,
      id: `${namespace(draft)}said-${String(draft.lastSeq)}`,
      turn: draft.runIndex,
      ...(shown.length === 0 ? {} : { images: shown }),
    }
    draft.items[position] = adopted
    draft.index?.delete(item.id)
    draft.index?.set(adopted.id, position)
    beginQuestion(draft)

    return true
  }

  return false
}

/**
 * 两份说法，都留下。
 *
 * message 是运行时报的（连接断了、进程没了），diagnostics 是 agent 自己说的
 * （Authentication required、配额用尽）。此前有后者时就把前者丢掉 —— 而排查
 * 一次失败要的恰好是两者的关系。重复的不写两遍，不重复的一句不删。
 */
function preferAgent(message: string, diagnostics?: string): string {
  const said = diagnostics?.trim() ?? ''
  const ours = message.trim()

  if (said.length === 0) {
    return message
  }

  return ours.length === 0 || said.includes(ours) ? said : `${message}\n${said}`
}

/**
 * 一轮结束，却一个字都没有。
 *
 * 这是一个事实，不是一句话：自这一轮的提问以来，转录里没有任何可看的条目。
 * 空转必须被说出来 —— 界面沉默等于把「我到底发出去了吗」丢给人自己猜。
 *
 * 但说出来的只能是协议自己的词：stopReason 的原值。
 *
 * agent 自己留下了 diagnostics 时根本走不到这里：一件事只有一个说法。
 *
 * 判据向后扫到本段边界为止，代价是一轮的长度，不是整条对话的长度；
 * isRenderable 与派生共用同一份 —— 抄第二份就会有两种「空」。提问单独跳过：
 * 它是两段之间的边界，不是这一段的产出。
 */
function silentTurn(draft: Draft, stopReason: AcpStopReason): string | undefined {
  for (let index = draft.items.length - 1; index >= 0; index -= 1) {
    const item = draft.items[index]

    if (item === undefined) {
      continue
    }

    if (item.turn !== draft.runIndex) {
      break
    }

    if (item.type === 'user_message') {
      continue
    }

    if (isRenderable(item)) {
      return undefined
    }
  }

  return `stopReason: ${stopReason}`
}

function finalStatus(stopReason: AcpStopReason): RunStatus {
  if (stopReason === 'cancelled') {
    return 'cancelled'
  }

  if (stopReason === 'refusal') {
    return 'failed'
  }

  return 'completed'
}
