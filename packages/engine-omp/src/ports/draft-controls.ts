import type { Controls, ModelRef, Posture } from '@poietica/engine'
import { availabilityOf } from '../plan-goal'
import { readSetting, type SettingsScope } from '../settings-access'
import type { OmpModelLike, RegistryPort } from './model-helpers'
import { aliasOf, ENABLED_MODELS_PATH, enabledMatcher, stringArrayOf } from './model-helpers'

/*
 * 草稿控件表（方案 §04 的 `AgentEngine.draftControls`）。
 *
 * 入口页（还没有 threadId）要画那排选择器，但**不能**为此开一个会话：开会话会写会话文件、
 * 会写设置，而用户可能只是打开首页看看。这一支因此只读三样：
 *
 *   1. `registry.getAvailable()` —— 此刻可用的模型（凭据作用域，与 omp 自己的选择器同源）；
 *   2. 当前模型的 `thinking.efforts` —— **静态**烤在模型目录里的档位梯子，不需要会话；
 *   3. `enabledModels` 白名单 —— 与会话里 /models 页同一条过滤（空表 = 全放行）。
 *
 * 它取代 legacy 的 `createAgentCapabilityBridge`：那一支要起一条 agent 连接才答得出来。
 */

/** 目录里的一条模型 → ModelRef。 */
function refOf(model: OmpModelLike): ModelRef {
  return { provider: model.provider, id: model.id }
}

/** 一档的界面文案：与 omp 自己的档位名同一拼法（'minimal' / 'low' / …）。 */
function labelOfLevel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

/** 全局那一档思考深度（session/settings.ts 的 `cfgDefaultThinkingLevel`；schema 默认 high）。 */
const DEFAULT_THINKING_PATH = 'defaultThinkingLevel'

/** 全局默认档的现读值：全新会话真的会落在那一档上，漏了它屏幕上就是「切一次档位才长出思考强度」。 */
function globalThinkingDefault(root: SettingsScope): string | null {
  const value = readSetting(root, DEFAULT_THINKING_PATH)
  return typeof value === 'string' && value !== '' ? value : null
}

/** 落在梯子上的那个档；不在梯子上（或没有梯子）就是 null —— 不编一档。 */
function inLadder(level: string | null | undefined, levels: readonly string[]): string | null {
  return level === null || level === undefined || !levels.includes(level) ? null : level
}

/**
 * 当前模型自己那条档位梯子。
 *
 * 取不到（模型没有 `thinking`，或那一格没有 `efforts`）就给空表 —— 与会话侧的
 * `thinkingLevelsOf` 同一条规矩：**不编四档**（07 页 §5E 的 `sessionConfigControlsOf`
 * 也是这个处置）。
 */
function levelsOf(model: OmpModelLike | undefined): readonly string[] {
  return model?.thinking?.efforts ?? []
}

export function draftControlsOf(input: {
  readonly registry: RegistryPort
  readonly root: SettingsScope
  readonly current: ModelRef | null
  readonly posture: Posture
  readonly thinking: string | null
}): Controls {
  const matcher = enabledMatcher(stringArrayOf(readSetting(input.root, ENABLED_MODELS_PATH)))
  const available = input.registry.available().filter((model) => matcher({ provider: model.provider, id: model.id }))

  /*
   * 选中的那一条：草稿给的 ref 优先（`init.model`），否则是调用方解出来的默认模型，
   * 再没有就是**目录里第一条可用的**。
   *
   * 那最后一档是必须的，不是顺手兜底：新装机器上 `modelRoles.default` 还没被谁写过，
   * 于是 current 是 null → 胶囊里模型名是空字符串 → 那颗按钮宽度塌成 0，屏幕上就是
   * 「输入框那一排没有模型选择」（真实故障）。而这条会话真跑起来时 SDK 自己也会挑一条，
   * 所以报出「会用的那一条」才是诚实的。
   *
   * 显式给了 ref 但目录里找不到它（下架的 id）时**照原样报出去**，不换成别的 ——
   * 那等于替用户做了决定。
   */
  const found = input.current === null ? undefined : input.registry.find(input.current.provider, input.current.id)
  const current = input.current ?? (available.length === 0 ? null : refOf(available[0]!))
  const owned = input.current === null ? (current === null ? undefined : available[0]) : found
  const levels = levelsOf(owned)

  /*
   * 档位：草稿给的优先，其次**这条模型自己声明的默认档**，再次全局 `defaultThinkingLevel`
   * （omp 建会话时的顺序正是这两条：sdk.ts 的 pickInitialThinkingLevel「selectedModel
   * 的 defaultLevel → 全局 defaultThinkingLevel」）。
   *
   * 全局那一档不能漏：DeepSeek 这类模型目录里只烤了 `efforts`、没有 `defaultLevel`，
   * 漏掉它就报出空档位 —— 屏幕上「模型卡片一开始没有思考强度，切一次才长出来」
   * （真机故障：会话文件里写的是 thinkingLevel=high，卡片上却是空的）。
   *
   * 落在梯子外的一律按「这一档不存在」处置（12 页 §7.7：「不在梯子里就为 null」）——
   * 上游 setThinkingLevel 会夹取，我们报一个夹取后不存在的档就是第二份语义。
   */
  const declared = owned?.thinking?.defaultLevel ?? globalThinkingDefault(input.root)
  const currentThinking = input.thinking ?? inLadder(declared, levels)

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
    /* 草稿表是「还没开会话」的那一份：可用性同样现读设置（参数里有 root） */
    available: availabilityOf(input.root),
    context: null,
  }
}

/** 草稿表里 current 的写法：provider/id（与 omp 侧 aliasOf 同一拼法）。 */
export function draftAliasOf(model: ModelRef | null): string | null {
  return model === null ? null : aliasOf(model)
}
