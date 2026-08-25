import type { TimelineItem } from './timeline-contract'

/**
 * 这一条会出现在转录里吗。
 *
 * 一个判据，三个读者：行投影用它决定哪一条上屏，reducer 用它回答「这一轮到底有没有
 * 产出」，等待指示器经由行投影问「屏幕上此刻是不是什么都没有」。抄成两份就会有两种
 * 「空」——屏幕上什么都没有、reducer 却认为这一轮有产出，那正是一次静默失败的成因。
 *
 * 推理与回答同一条判据：两者都是模型写出的 markdown 流，都进转录，音量由样式分开。
 * 屏幕上因此没有第二条思考通道 ——「此刻在想什么」与「刚才想过什么」是同一份事实。
 */
export function isRenderable(item: TimelineItem): boolean {
  if (item.type === 'agent_text' || item.type === 'agent_thought') {
    return item.text.length > 0
  }

  /* 空的一句话是 agent 回放里被剥空的注入（saidByUser），不是人说的话。 */
  if (item.type === 'user_message') {
    return item.text.length > 0 || (item.images?.length ?? 0) > 0
  }

  if (item.type === 'plan') {
    return item.entries.length > 0
  }

  /* 还没结清的题不进转录 —— 它正长在输入框那张卡里。结清了才留下记录。 */
  if (item.type === 'question') {
    return item.resolution !== undefined
  }

  /* 还在排队的那句长在输入框上方的队列条里；并进这一轮之后这里才留下痕迹。 */
  if (item.type === 'queued_prompt') {
    return item.settled === true
  }

  /* 审批不上屏：待答的那一道摊在输入框上方，答过的是操作痕迹，痕迹归事件日志。 */
  if (item.type === 'permission') {
    return false
  }

  return true
}
