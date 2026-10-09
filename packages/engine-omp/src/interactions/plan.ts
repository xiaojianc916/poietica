import type { InteractionAnswer } from '@poietica/engine'
import type { InteractionDraft } from './broker'

/**
 * 计划模式下的「提交计划 / 请求批准」（12 页 §8.5，迁移 legacy bridge.ts:3525-3589 的
 * proposePlan / askPlanApproval；四档答复的判据按产品负责人 2026-10-07 的定稿）。
 *
 * omp 那边只有一条 `xd://propose`：agent 写计划文件，plan mode 的 PlanProposalHandler 收到标题。
 * 这里把「标题 + 计划正文」翻成产品的 `kind:'plan'` 卡片，答复（approve / reject / revise + feedback）
 * 再翻回 omp 要的东西：
 * - approve：把计划的 `local://` 路径登记为参考（setPlanReferencePath），并交给调用方退出计划模式；
 * - revise：留在计划模式里，把人的反馈原样回给模型，让它改完再提一次；反馈为空时与 reject 同义；
 * - reject / dismiss（超时、中止、cancelAll）：这一次提交作废，但**仍然留在计划模式里** ——
 *   出模式等于告诉模型可以动手了。dismiss 是「取消、退出计划模式」这一档的兑现（§7.8）。
 *
 * legacy 走的是授权闸门那张选项表（所以答复与工具授权逐字同形），新设计里计划有自己的 kind，
 * 卡片因此能画计划正文，而不必把整篇计划塞进一句 select 标题里。
 */

/** 产品那三颗按钮的取值域 */
export type PlanDecision = Extract<InteractionAnswer, { kind: 'plan' }>['decision']

/** 一次计划提交在 omp 侧的样子（preparePlanForReview 的 details） */
export interface PlanProposal {
  readonly title: string
  /** agent 选定的计划文件路径（`local://<slug>-plan.md`）；批准后作为参考路径 */
  readonly planFilePath: string
  /** 计划正文（读文件失败时为空串；没有正文就不假装有） */
  readonly markdown: string
}

/**
 * 计划提交 → 产品交互草稿。标题用 omp 解析好的题目，正文原样带上（不截断、不改写）；
 * 正文缺席时如实为空串，卡片据此只显示标题，而不是编一段。
 */
export function planInteraction(proposal: PlanProposal): InteractionDraft {
  return {
    kind: 'plan',
    title: proposal.title,
    planFilePath: proposal.planFilePath,
    planMarkdown: proposal.markdown,
  }
}

/** 一次计划答复的结论：批不批、以及要不要把人的话回给模型 */
export interface PlanOutcome {
  readonly decision: PlanDecision
  /** approve 之外都带反馈；没有就说 null，不编一句 */
  readonly feedback: string | null
}

/**
 * 产品答复 → 计划结论。dismiss（超时 / 中止 / 取消这一轮）按 reject 处理：没人批就是不批，
 * 这一版计划作废但仍留在计划模式里，下一版还能再提。
 */
export function planOutcomeOf(answer: InteractionAnswer): PlanOutcome {
  if (answer.kind !== 'plan') return { decision: 'reject', feedback: null }
  if (answer.decision === 'approve') return { decision: 'approve', feedback: answer.feedback }
  if (answer.decision === 'revise') {
    const trimmed = answer.feedback?.trim() ?? ''
    // 说了要改却一个字没给：回给模型等于让它猜，按作废处理更说得清
    return trimmed === '' ? { decision: 'reject', feedback: null } : { decision: 'revise', feedback: trimmed }
  }
  return { decision: 'reject', feedback: answer.feedback }
}

/** 计划获批准时回给模型的工具结果（产品负责人 2026-10-07 定稿的文案） */
export function planApprovedText(planFilePath: string): string {
  return `计划已确认：${planFilePath}。按它执行。`
}

/** 计划被要求修改时回给模型的工具结果：把人的意见原样带上 */
export function planRevisionText(planFilePath: string, feedback: string): string {
  return `计划未获批准：${planFilePath}。用户意见：${feedback}。修改计划文件后重新提交。`
}

/**
 * 计划被否决（含 dismiss）时回给模型的工具结果。
 *
 * 比 legacy 多一句「不要重新提交」：人否决之后模型再提一版会把这张卡片重新推上来，
 * 而人的意思恰恰是停下 —— 说清楚比让它猜好。
 */
export function planRejectedText(planFilePath: string): string {
  return `计划被否决：${planFilePath}。不要执行，也不要重新提交，等待用户指示。`
}
