import type { InteractionAnswer } from '@poietica/engine'

/*
 * 三类单问（Q1-E）：扩展与工具经 omp 的 `ctx.ui` 发来的「是否 / 单选 / 一句话」。
 * 卡片借提问面板的样子，但答复是它们自己那一支 —— 引擎按种类收，答成 `approval` 或 `question` 会被拒。
 */

/** 卡片要画的：标题之外各类自己那一格。 */
export type DialogRequest =
  | { readonly kind: 'confirm'; readonly title: string; readonly message: string }
  | { readonly kind: 'select'; readonly title: string; readonly options: readonly string[] }
  | { readonly kind: 'input'; readonly title: string; readonly placeholder?: string; readonly multiline: boolean }

/** 取引擎契约那三支，不另立词表（同 PlanAnswer）。 */
export type DialogAnswer = Extract<InteractionAnswer, { kind: 'confirm' | 'select' | 'input' }>
