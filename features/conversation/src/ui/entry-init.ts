import type { ModelRef, Posture } from '@poietica/engine'
import type { SessionConfigControl } from './agent/config'
import { postureOfControl } from './control-shapes'

/*
 * 入口页发送时铸出的线程初始化（07 页 §5E「新对话入口页的选择器」的发送流程）。
 *
 * 方案原文（07 页 §5E）：
 *
 *   1. 取最近一次 `controls.draft` 结果的 `model.current`、`thinking.current`、`posture`。
 *   2. `threads.create({ workspaceId, posture, model, thinking })`，值为 null 的字段不传。
 *
 * 这三格不能只带「用户手改过的草稿」：那样没动过选择器时一个都不传，omp 自己按
 * 内置目录另挑一条 —— 屏幕上写着 A、会话里跑的是 B（真机故障：入口页显示
 * DeepSeek-V4.1-Flash，发送后会话文件里是 deepseek-v4-pro）。屏幕上的那一份
 * （草稿覆盖后的 `controls.draft` 结果）才是这条线程的初始化。
 *
 * 判据收在这个无 React 的模块里：它是纯函数，可单测；组件只负责把入参算好。
 */

/** 入口页那排选择器的本地草稿：用户手改过的那几格。 */
export interface DraftSelection {
  readonly model?: ModelRef | null | undefined
  readonly thinking?: string | null | undefined
  readonly posture?: Posture | undefined
  /**
   * 计划模式与目标（07 页 §5E、产品负责人 2026-10-07 定稿）：
   * **入口这一格没有会话**，所以两档都先记在这里，等铸出号之后再补下发给会话。
   */
  readonly plan?: boolean | undefined
  readonly goal?: boolean | undefined
}

export interface EntryThreadInit {
  readonly workspaceId: string
  readonly posture?: Posture
  readonly model?: ModelRef
  readonly thinking?: string
}

/** 控件表里某一格（模型 / 思考）此刻的取值；整张表缺席时要的是「没有」，不是猜一个。 */
function currentOf(controls: readonly SessionConfigControl[], id: string): string | null {
  const control = controls.find((candidate) => candidate.id === id)
  return control === undefined || control.current === '' ? null : control.current
}

/** 控件表里模型那一格的写法（`provider/id`，见 control-shapes 的 sessionConfigControlsOf）。 */
function modelRefOfAlias(alias: string | null): ModelRef | null {
  if (alias === null) {
    return null
  }
  const at = alias.indexOf('/')
  return at > 0 ? { provider: alias.slice(0, at), id: alias.slice(at + 1) } : null
}

/**
 * 算这条入口提交要带的初始化。
 *
 * - `draft`（用户手改过的格）优先于 `controls`（最近一次草稿表的结果）；
 * - 档位跟着**生效的那条模型**走：草稿表里那份档位只在这条模型与生效模型一致时
 *   才可用 —— 换了模型但表还没重读回来时，旧模型的档位可能正是新模型没有的那一档，
 *   不传比传错好（引擎会按这条模型自己的默认档落定）；
 * - `posture` 由调用方先算好生效值（本地草稿 → 持久意图）传进来；两处都没有时
 *   退回草稿表报的那一档（引擎默认档就在那张表里）；
 * - 值为 null 的字段**不传**（方案原文的「值为 null 的字段不传」）；返回 null
 *   表示这一刻还开不出对话（例如工作区名单还没回来）。
 */
export function entryThreadInitOf(input: {
  readonly workspaceId: string | undefined
  readonly draft: DraftSelection
  readonly controls: readonly SessionConfigControl[]
  readonly posture?: Posture | undefined
}): EntryThreadInit | null {
  if (input.workspaceId === undefined) {
    return null
  }
  const shownModel = modelRefOfAlias(currentOf(input.controls, 'model'))
  const model = input.draft.model ?? shownModel
  const sameModel =
    model !== null && shownModel !== null && model.provider === shownModel.provider && model.id === shownModel.id
  const thinking = input.draft.thinking ?? (sameModel ? currentOf(input.controls, 'thought') : null)
  const shownPosture = currentOf(input.controls, 'permission')
  const posture = input.posture ?? (shownPosture === null ? null : (postureOfControl(shownPosture) ?? null))

  return {
    workspaceId: input.workspaceId,
    ...(posture === null ? {} : { posture }),
    ...(model === null ? {} : { model }),
    ...(thinking === null ? {} : { thinking }),
  }
}
