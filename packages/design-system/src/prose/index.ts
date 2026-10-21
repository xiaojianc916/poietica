/*
 * `@poietica/design-system/prose`：把一段 Markdown 画成正文（streamdown + 代码高亮 + 数学 + pele 渲染的图 + 流式波浪淡入）。
 *
 * 与 `./diff` 同理单开子入口：它带着 streamdown / shiki / katex / pele 这一串重依赖，不进根入口的闭包。
 * 子入口本身也只是轻壳（prose-shell.tsx）：实现在独立分块里，首帧之后预取、用到时按需加载，不进首屏入口闭包（性能方案 P5）。
 * 会话时间线、计划坞、技能文档、PR 页都从这里取同一份排版 —— 它不认识会话、不调 RPC、不持有功能状态。
 */
export { loadMath } from './math-plugin'
export { Prose, type ProseProps, prefetchProseWhenIdle, preloadProse, useProseSettled } from './prose-shell'
