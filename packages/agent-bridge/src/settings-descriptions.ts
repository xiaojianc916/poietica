/*
 * omp 设置的中文说明。
 *
 * omp 自己没有 i18n（实测：整个 @oh-my-pi 树零语言包、零翻译函数），所以中文只能我们出。
 * 键是 omp 自己的 **path**（不是英文 label）：path 是稳定标识符，label 是会自动改词的散文。
 * 查不到就原样交回 omp 的英文说明 —— 这是这张表作为「第二份事实」的唯一安全阀：
 * 上游加一格设置时我们只是没翻，不会漏能力，也不会显示空白（AGENTS.md §0）。
 *
 * 说明分三片维护（a/b/c），为的是让「译」这件事可以并行且每片都小到能一次翻完；
 * 合并只在这一个文件里发生，调用方看不到分片。
 */

import { DESCRIPTIONS_A } from './settings-descriptions.a.ts'
import { DESCRIPTIONS_B } from './settings-descriptions.b.ts'
import { DESCRIPTIONS_C } from './settings-descriptions.c.ts'

/** 三片合起来：键不重叠（有测试双向钉住），所以直接铺开。 */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  ...DESCRIPTIONS_A,
  ...DESCRIPTIONS_B,
  ...DESCRIPTIONS_C,
}

/**
 * 这一格的说明，中文优先。
 *
 * 认不出的 path 交回 `fallback`（omp 的英文原文），绝不返回空串 —— 空的说明比英文更坏：
 * 它让人以为这一格没有说明。
 */
export function settingDescriptionOf(path: string, fallback: string): string {
  return DESCRIPTIONS[path] ?? fallback
}

/** 这一格的说明有没有中文；界面据此决定要不要把英文原文摆在下面。 */
export function hasDescriptionTranslation(path: string): boolean {
  return path in DESCRIPTIONS
}
