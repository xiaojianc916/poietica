/*
 * `@poietica/design-system/prose`：把一段 Markdown 画成正文（streamdown + 代码高亮 + 数学 + pele 渲染的图 + 流式波浪淡入）。
 * 与 `./diff` 同理单开子入口：带着 streamdown / shiki / katex / pele 一串重依赖，不进根入口的闭包；
 * 子入口本身也只是轻壳（prose-shell.tsx），实现在独立分块里、首帧后预取（性能方案 P5）。
 * 会话时间线、计划坞、技能文档、PR 页都从这里取同一份排版 —— 它不认识会话、不调 RPC、不持有功能状态。
 */

export { type ProseFileLinks, ProseFileLinksContext } from './file-links-context'
export { type FileRef, isAbsoluteFilePath } from './file-ref'
export { loadMath } from './math-plugin'
export { Prose, type ProseProps, prefetchProseWhenIdle, preloadProse, useProseSettled } from './prose-shell'
