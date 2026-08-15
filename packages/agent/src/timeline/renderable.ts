import type { TimelineItem } from './timeline-contract'

/**
 * 这一条会出现在转录里吗。
 *
 * 一个判据，三个读者：行投影用它决定哪一条上屏，reducer 用它回答「这一轮到底有没有
 * 产出」，等待指示器经由行投影问「屏幕上此刻是不是什么都没有」。抄成两份就会有两种
 * 「空」——屏幕上什么都没有、reducer 却认为这一轮有产出，那正是一次静默失败的成因。
 *
 * 思考不上屏。
 *
 * 两条通道照旧全收：agent_thought_chunk 与 agent_message_chunk 分别落成 agent_thought
 * 与 agent_text（acp-projection.ts），上游 kimi-code 的 acp-adapter 也是这么分的
 * （thinking.delta / assistant.delta 各映一种 sessionUpdate）。但「收下」与「摊开」是
 * 两件事：推理是模型写给自己的草稿，逐字摊在读者眼前会把结论挤出屏幕，也会让人把
 * 草稿当结论读。标杆都不摊——Codex 的原始推理关在 show_raw_agent_reasoning 后面
 * （core/state/service.rs 持有它，protocol/legacy_events.rs 按它决定发不发，TUI 只在
 * --oss 下置真）；kimi-code 的 VS Code 界面在 showThinkingContent 为假时只画一个
 * 「Thinking」标签加一个转圈（ThinkingBlock.tsx），正文一个字不出。
 *
 * 所以转录里只有人说的话、回答、工具调用、计划与报错。这个决定只在这里做一次：
 * ReasoningPanel 仍挂在 TimelineRow 那个穷尽 switch 上，由类型系统看着——条目联合里
 * 还有 agent_thought，那个分支就删不掉；要让思考重新上屏，也只改这一行。
 */
export function isRenderable(item: TimelineItem): boolean {
  if (item.type === 'agent_thought') {
    return false
  }

  if (item.type === 'agent_text') {
    return item.text.length > 0
  }

  /* 空的一句话是 agent 回放里被剥空的注入（saidByUser），不是人说的话。 */
  if (item.type === 'user_message') {
    return item.text.length > 0 || (item.images?.length ?? 0) > 0
  }

  if (item.type === 'plan') {
    return item.entries.length > 0
  }

  return true
}
