import './thinking-indicator.css'

/**
 * 一轮已经开始，屏幕上却还没有东西在动。
 *
 * 不是转录里的一条：什么都还没发生，没有可记的东西。出没由行投影回答
 * （selectIsWaiting），落点在转录尾部，第一帧上屏就撤。
 *
 * 说的是「正在思考」，不是三个点。点只能证明这东西还活着，说不出它在做什么；而读者
 * 把原始思考链藏起来之后，这段静止正是一轮里最长的一段 —— 同一格上，Codex 关掉
 * show_raw_agent_reasoning 时留一行状态，kimi-code 的 ThinkingBlock 在不展示思考内容
 * 时只画一个标签。文字本身就是无障碍名，不再另挂一份视觉隐藏的副本。
 */
export function ThinkingIndicator() {
  return (
    <p className="timeline-thinking" role="status">
      正在思考
    </p>
  )
}
