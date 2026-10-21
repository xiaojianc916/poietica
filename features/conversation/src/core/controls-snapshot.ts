import { ContextUsage, Controls, ModelRef, type Posture, SessionGoalSnapshot } from '@poietica/engine'
import { z } from 'zod'

/**
 * 控件表快照（性能方案 P4）：一条**没开着**的对话，输入框那一排选择器照它画 —— 看一眼历史对话不为一张控件表去打开会话。
 *
 * 只存会话自己的那几格：此刻的模型（连同它在候选里的样子）、思考档位与梯子、计划模式、目标、上下文用量。
 * 别的格子冷读时现取，不进快照：模型候选与两档可用性跟着目录与设置走（引擎的草稿表现读），姿态以线程行为准。
 * 它只是缓存 —— 活会话每报一次控件表、上下文用量就覆盖一次；读不懂（老版本写的、坏 JSON）按没有处置，调用方退回打开会话现问。
 */
const ModelChoice = Controls.shape.model.shape.choices.element

export const ControlsSnapshot = z.object({
  model: ModelRef.nullable(),
  /** 当前那一条在候选里的样子：会话自己挑的模型可能不在目录里（下架、白名单外），冷读时照原样补回候选 */
  choice: ModelChoice.nullable(),
  thinking: Controls.shape.thinking,
  planMode: z.boolean(),
  goal: z.string().nullable(),
  goalSnapshot: SessionGoalSnapshot.nullable(),
  context: ContextUsage.nullable(),
})
export type ControlsSnapshot = z.infer<typeof ControlsSnapshot>

type ModelChoice = z.infer<typeof ModelChoice>

const sameRef = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.id === b.id

/** 活会话报来的一整张控件表 → 快照 */
export function snapshotOf(controls: Controls): ControlsSnapshot {
  const current = controls.model.current
  return {
    model: current,
    choice: current === null ? null : (controls.model.choices.find((choice) => sameRef(choice.ref, current)) ?? null),
    thinking: controls.thinking,
    planMode: controls.planMode,
    goal: controls.goal,
    goalSnapshot: controls.goalSnapshot ?? null,
    context: controls.context,
  }
}

/** 库里那一格 → 快照；没有、坏 JSON、形状对不上都是 null（调用方退回打开会话） */
export function parseSnapshot(text: string | null): ControlsSnapshot | null {
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = ControlsSnapshot.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * 快照 + 现读的草稿表 → 冷读那一张控件表。与活会话 `controls()` 同一条组装规矩：候选是此刻目录里的可用模型，
 * 当前那一条不在候选里时补在最前（会话自己挑的模型可能不在白名单里）；姿态用线程行（`controls.setPosture` 两边一起改）。
 */
export function controlsFromSnapshot(snapshot: ControlsSnapshot, draft: Controls, posture: Posture): Controls {
  const current = snapshot.model
  const offered = draft.model.choices
  const missing: ModelChoice | null =
    current === null || offered.some((choice) => sameRef(choice.ref, current))
      ? null
      : (snapshot.choice ?? { ref: current, label: current.id, reasoning: true, images: true })
  return {
    model: { current, choices: missing === null ? [...offered] : [missing, ...offered] },
    thinking: snapshot.thinking,
    posture,
    planMode: snapshot.planMode,
    goal: snapshot.goal,
    goalSnapshot: snapshot.goalSnapshot,
    available: draft.available,
    context: snapshot.context,
  }
}
