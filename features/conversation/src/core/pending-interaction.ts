import type { Interaction } from '@poietica/engine'
import type { PendingInteraction } from '../contract/entities'

/**
 * 引擎的六种交互折成侧栏要画的三档。
 *
 * select / input / confirm 是扩展与工具经 omp 的 `ctx.ui` 发来的单问（Q1-E），对用户来说与
 * 「回答一个问题」是同一件事，所以与 question 同档；approval 与 plan 各自是一道独立的闸，
 * 分别有自己的短标签（待审批 / 计划待审）。
 */
function kindOf(interaction: Interaction): PendingInteraction {
  switch (interaction.kind) {
    case 'approval':
      return 'approval'
    case 'plan':
      return 'plan'
    case 'question':
    case 'select':
    case 'input':
    case 'confirm':
      return 'question'
  }
}

/**
 * 同一时刻挂着多个待答交互时报哪一档。
 *
 * 三道闸的紧急程度不同：审批拦的是「agent 即将动手」，计划拦的是「整轮还没开始」，提问只拦
 * 下一步。取最靠前的那一档，行尾那一句话才说得出「现在最该先处理什么」；同一档里取最早登记的
 * （broker 的 pending() 按登记顺序给出），与卡片从上到下的次序一致。
 */
const RANK: Record<PendingInteraction, number> = { approval: 0, plan: 1, question: 2 }

export function pendingInteractionOf(interactions: readonly Interaction[]): PendingInteraction | null {
  let found: PendingInteraction | null = null
  for (const interaction of interactions) {
    const kind = kindOf(interaction)
    if (found === null || RANK[kind] < RANK[found]) found = kind
  }
  return found
}
