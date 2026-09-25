import type { TimelineItem } from './timeline-contract'

// 唯一判据，三个读者：行投影决定哪条上屏、reducer 回答这一轮有没有产出、
// 等待指示器问屏幕上此刻是不是什么都没有。抄成两份就会有两种「空」。
export function isRenderable(item: TimelineItem): boolean {
  if (item.type === 'agent_text' || item.type === 'agent_thought') {
    return item.text.length > 0
  }

  // 空的一句话是 agent 回放里被剥空的注入，不是人说的话。
  if (item.type === 'user_message') {
    return item.text.length > 0 || (item.images?.length ?? 0) > 0 || (item.files?.length ?? 0) > 0
  }

  // 还没结清的题不进转录，正长在输入框那张卡里。
  if (item.type === 'question') {
    return item.resolution !== undefined
  }

  if (item.type === 'inflight_prompt') {
    return false
  }

  // 审批不上屏：待答的摊在输入框上方，答过的是操作痕迹归事件日志。
  if (item.type === 'permission') {
    return false
  }

  return true
}
