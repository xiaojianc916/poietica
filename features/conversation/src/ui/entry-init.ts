import type { ModelRef, Posture } from '@poietica/engine'
import { postureOfControl } from './session/configuration/control-shapes'
import type { SessionConfigControl } from './shared/model/config'

/*
 * 屏幕上那一份（草稿覆盖后的 `controls.draft` 结果）才是这条线程的初始化。只带「用户手改过的草稿」时，没动过选择器就一个都不传，omp 按内置目录另挑一条 ——
 * 屏幕上写着 A、会话里跑的是 B（真机故障：入口页显示 DeepSeek-V4.1-Flash，发送后会话文件里是 deepseek-v4-pro）。
 */

export interface DraftSelection {
  readonly model?: ModelRef | null | undefined
  readonly thinking?: string | null | undefined
  readonly posture?: Posture | undefined
  /** **入口这一格没有会话**，所以计划模式与目标都先记在这里，等铸出号之后再补下发给会话。 */
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

/** 控件表里模型那一格的写法（`provider/id`）。 */
function modelRefOfAlias(alias: string | null): ModelRef | null {
  if (alias === null) {
    return null
  }
  const at = alias.indexOf('/')
  return at > 0 ? { provider: alias.slice(0, at), id: alias.slice(at + 1) } : null
}

/**
 * `draft`（用户手改过的格）优先于 `controls`（最近一次草稿表的结果）。档位跟着**生效的那条模型**走：换了模型但表还没重读回来时，
 * 旧模型的档位可能正是新模型没有的那一档，不传比传错好。值为 null 的字段**不传**；返回 null 表示这一刻还开不出对话。
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
