import type { Automation, AutomationRun } from '../contract/entities'

/*
 * 什么时候告诉用户（审查 R-14）。判定只在这里一处：Core 判、UI 只转成系统通知
 * （platform 的 notify.show 在主窗口聚焦时本来就不弹，所以这里不管窗口状态）。
 *
 *   never      → 一律不通知；
 *   attention  → 失败（含超时）、等批准，或 agent 汇报时标了 attention；
 *   always     → attention 的全部，再加每次成功。
 * 用户自己点的停止（cancelled）与跳过（skipped）从不通知：前者用户就在场，后者只记账。
 */
export interface Notice {
  readonly title: string
  readonly body: string
}

export const APPROVAL_NOTICE_BODY = '有一项操作需要你批准才能继续；2 小时内没处理会停止本次运行。'

export function noticeOf(
  automation: Pick<Automation, 'title' | 'notify'>,
  run: AutomationRun,
  moment: 'settled' | 'awaiting',
): Notice | null {
  if (automation.notify === 'never') return null
  const name = `「${automation.title}」`
  if (moment === 'awaiting') return { title: `${name}等待你批准`, body: APPROVAL_NOTICE_BODY }
  if (run.outcome === 'failed') return { title: `${name}运行失败`, body: run.message ?? '运行失败，点开查看详情。' }
  if (run.outcome !== 'succeeded') return null
  if (run.attention) return { title: `${name}需要你关注`, body: run.summary ?? '运行完成，点开查看结果。' }
  if (automation.notify === 'always') return { title: `${name}已完成`, body: run.summary ?? '运行完成，点开查看结果。' }
  return null
}
