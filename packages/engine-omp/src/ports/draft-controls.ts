import type { Controls, ModelRef, Posture } from '@poietica/engine'
import { availabilityOf } from '../session/plan-goal'
import { readSetting, type SettingsScope } from '../settings-access'
import type { OmpModelLike, RegistryPort } from './model-helpers'
import { aliasOf, ENABLED_MODELS_PATH, enabledMatcher, stringArrayOf } from './model-helpers'

/*
 * 入口页（还没有 threadId）要画那排选择器，但**不能**为此开一个会话：开会话会写会话文件。这一支只读
 * 三样 —— registry 里此刻可用的模型、当前模型静态烤在目录里的 `thinking.efforts`、`enabledModels` 白名单。
 */

function labelOfLevel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

/** 全局那一档思考深度（session/settings.ts 的 `cfgDefaultThinkingLevel`；schema 默认 high） */
const DEFAULT_THINKING_PATH = 'defaultThinkingLevel'

/** 全局默认档的现读值：漏了它屏幕上就是「切一次档位才长出思考强度」 */
function globalThinkingDefault(root: SettingsScope): string | null {
  const value = readSetting(root, DEFAULT_THINKING_PATH)
  return typeof value === 'string' && value !== '' ? value : null
}

function inLadder(level: string | null | undefined, levels: readonly string[]): string | null {
  return level === null || level === undefined || !levels.includes(level) ? null : level
}

/**
 * omp 的档位全序（pi-catalog `THINKING_EFFORTS`，effort.ts）。`off` 不在其中 —— 它不是「一档」。
 * engine-omp 不能直接依赖 pi-catalog（只允许已声明依赖），所以这里抄一份；上游加档时要同步。
 */
export const THINKING_ORDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 与 omp 建会话/切模型时同一条夹取规矩（pi-catalog `clampThinkingLevelForModel`，model-thinking.ts）：
 * 在梯子里原样；否则取梯子里不超过请求的最高一档；再没有就取梯子第一档。梯子为空（非推理模型、目录没烤）
 * 报 null —— 不编档位。不夹取的后果是真实故障：草稿里存着上一个模型的 `max`，换到只有
 * low/medium/high 的模型，胶囊上显示 Max、发出去却被 omp 夹成 high，「切一次档位才对上」。
 */
export function clampToLadder(level: string | null | undefined, levels: readonly string[]): string | null {
  if (level === null || level === undefined || level === '' || levels.length === 0) return null
  if (levels.includes(level)) return level
  const rank = THINKING_ORDER.indexOf(level)
  if (rank >= 0) {
    for (let i = rank; i >= 0; i -= 1) {
      const candidate = THINKING_ORDER[i]!
      if (levels.includes(candidate)) return candidate
    }
  }
  return levels[0] ?? null
}

/** 当前模型自己那条档位梯子；取不到就给空表 —— 与 `thinkingLevelsOf` 同一条规矩：**不编四档** */
function levelsOf(model: OmpModelLike | undefined): readonly string[] {
  return model?.thinking?.efforts ?? []
}

export function draftControlsOf(input: {
  readonly registry: RegistryPort
  readonly root: SettingsScope
  readonly current: ModelRef | null
  readonly posture: Posture
  readonly thinking: string | null
  /** UI 「已配置的模型」里关掉的 provider/id；只约束兜底那一档（见下） */
  readonly hidden?: readonly string[]
}): Controls {
  const matcher = enabledMatcher(stringArrayOf(readSetting(input.root, ENABLED_MODELS_PATH)))
  const available = input.registry.available().filter((model) => matcher({ provider: model.provider, id: model.id }))
  const hidden = new Set(input.hidden ?? [])
  /*
   * 兜底候选：跳过用户关掉的模型。真实故障：注册表第一条恰好是用户在设置里关掉的那条，入口页一打开
   * 就选中它（而它在选择器列表里根本不出现）。全被关掉时退回 available[0]，宁可显示一条也不让胶囊塌成 0 宽。
   */
  const fallback = available.find((model) => !hidden.has(aliasOf(model))) ?? available[0]

  /*
   * 选中的那一条：草稿给的 ref 优先，其次调用方解出来的默认模型，再没有就是目录里第一条可用的。
   * 最后一档是必须的：新装机器上 `modelRoles.default` 还没被写过，current 为 null 会让胶囊里模型名
   * 是空串、按钮宽度塌成 0，屏幕上就是「输入框那一排没有模型选择」（真实故障）。显式给了 ref 但目录里
   * 找不到它（下架的 id）时照原样报出去，不换成别的 —— 那等于替用户做了决定。
   */
  const found = input.current === null ? undefined : input.registry.find(input.current.provider, input.current.id)
  const current = input.current ?? (fallback === undefined ? null : { provider: fallback.provider, id: fallback.id })
  const owned = input.current === null ? fallback : found
  const levels = levelsOf(owned)

  /*
   * 档位：草稿给的优先，其次这条模型自己声明的默认档，再次全局 `defaultThinkingLevel`（omp 建会话时
   * 的顺序正是这两条）。全局那一档不能漏：DeepSeek 这类模型目录里只烤了 `efforts`、没有 `defaultLevel`，
   * 漏掉它就报出空档位（真机故障：会话文件里写的是 thinkingLevel=high，卡片上却是空的）。草稿给的档位
   * 按 omp 同一规矩夹到这条梯子上（上游发送时也会夹，报夹取前的值就是第二份语义）；目录里找不到这条
   * 模型（梯子为空）时草稿值原样报出 —— 与上游「模型不存在原样返回」一致。默认档落在梯子外按「不存在」处置。
   */
  const declared = owned?.thinking?.defaultLevel ?? globalThinkingDefault(input.root)
  const requested = input.thinking === null || input.thinking === '' ? null : input.thinking
  const currentThinking =
    requested !== null
      ? owned === undefined
        ? requested
        : clampToLadder(requested, levels)
      : inLadder(declared, levels)

  return {
    model: {
      current,
      choices: available.map((model) => ({
        ref: { provider: model.provider, id: model.id },
        label: model.name ?? model.id,
        reasoning: model.reasoning === true,
        images: model.input?.includes('image') === true,
      })),
    },
    thinking: {
      current: currentThinking,
      choices: levels.map((level) => ({ id: level, label: labelOfLevel(level) })),
    },
    posture: input.posture,
    planMode: false,
    goal: null,
    /** 草稿表是「还没开会话」的那一份：可用性同样现读设置（参数里有 root） */
    available: availabilityOf(input.root),
    context: null,
  }
}

/** 草稿表里 current 的写法：provider/id（与 omp 侧 aliasOf 同一拼法） */
export function draftAliasOf(model: ModelRef | null): string | null {
  return model === null ? null : aliasOf(model)
}
