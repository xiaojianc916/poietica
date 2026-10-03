/*
 * 期望态：**不建会话**就能读、能改的那半张表。
 *
 * 「点开新对话，工具条上那些格子立刻要有值、要能点」这件事本来不必付水合的钱。omp 的
 * 官方分工是清楚的（ADR 0018 决定四、ADR 0021）：
 *
 *   - 期望态住配置里：`Settings` 合并五层配置，不做任何 agent 发现；
 *   - 清单住各自的轻量发现 API：`discoverSkills` 扫盘解析、`loadAllMCPConfigs` 只读配置；
 *   - 模型身份住目录：`ModelRegistry` 补完凭据页之后 `getAvailable()` 就是内存读。
 *
 * 所以这一份读的是「用户配成什么样」，不是「会话此刻是什么样」。两者只在模型与档位的
 * 默认值上重合 —— 而入口要的正是会话还没产生时的那个值。
 *
 * 与 bridge.ts 的 readSelectors 是**两个寿命**：那一份读会话对象（轮次级事实），
 * 这一份读配置与目录（进程级事实）。合成一份就得先有水合，那正是要避开的。
 *
 * 模型与档位的解析全走官方解析器（resolveModelRoleValue / resolveAllowedModels），
 * 不自己拼「默认角色 → 模型」的匹配规则：那是第二份选择器语义，两边必然分叉。
 */

import type { ModelRegistry, Settings } from '@oh-my-pi/pi-coding-agent'
import {
  getModelMatchPreferences,
  resolveAllowedModels,
  resolveModelRoleValue,
} from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import type { SelectorControl } from './protocol.ts'
/* 全局默认档与读写的唯一产地：与会话收敛（bridge.ts 的 settleThinking）同一处。 */
import { globalThinkingDefault, settingValueOf, writeSettingValue } from './settings.ts'
/* 档位判据单一产地：与收敛会话用的是同一条规则，两份就会分叉（thinking.ts 头部）。 */
import { thinkingToSettle } from './thinking.ts'

/* 模型对象的形状从官方解析器的返回值上取，不从 SDK 根找 `Model` —— 根 barrel 只挑了几样
   （index.ts），拿不到不等于没有那个类型。 */
type ResolvedModel = Awaited<ReturnType<typeof resolveAllowedModels>>[number]

/* 产品三档 → 上游 tools.approvalMode。取值与 label 与 bridge.ts 的 POSTURES 同源；
   两份各自写会分叉，所以这一份只从 settings 读模式、按同一张表取标签。 */
export const EXPECTED_POSTURES: readonly {
  readonly value: string
  readonly label: string
  readonly mode: 'always-ask' | 'write' | 'yolo'
}[] = [
  { value: 'manual', label: '请求批准', mode: 'always-ask' },
  { value: 'yolo', label: '帮我批准', mode: 'write' },
  { value: 'auto', label: '完全访问权限', mode: 'yolo' },
]

export interface ExpectedSkill {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly source: string
  readonly kind: string | null
  readonly disableModelInvocation: boolean | null
}

export interface ExpectedServer {
  readonly id: string
  readonly name: string
  /*
   * 配置层说「配了哪几台」是即时事实；连上了没有属于连接层（要 spawn 子进程）。
   * 入口这一格如实报「还没连」，由会话就绪后那次重读补齐。
   */
  readonly status: 'connected' | 'connecting' | 'disconnected' | 'error'
  readonly toolCount: number
  readonly lastError: string | null
}

export interface ExpectedState {
  readonly controls: readonly SelectorControl[]
  readonly skills: readonly ExpectedSkill[]
  readonly mcpServers: readonly ExpectedServer[]
}

/* 当前生效的模型：默认角色解析出来的那一个，解析不出来就取第一个有钥匙的。 */
function expectedModel(
  registry: ModelRegistry,
  settings: Settings,
  allowed: readonly ResolvedModel[],
): ResolvedModel | undefined {
  const resolved = resolveModelRoleValue(settings.getModelRole('default'), [...allowed], {
    settings,
    matchPreferences: getModelMatchPreferences(settings),
  })

  return resolved.model ?? allowed.find((model) => registry.hasConcreteAuth(model.provider))
}

/* 见下面 thinking 那一格的注释：这一行是 pi-catalog/model-thinking.ts 的 getSupportedEfforts。 */
function supportedEfforts(model: ResolvedModel): readonly string[] {
  return model.reasoning === true ? ((model.thinking?.efforts ?? []) as readonly string[]) : []
}

/* 模型那一格的取值拼法必须与 bridge.ts 的 aliasOf 逐字相同，否则入口选的与会话读的
   会变成两个不同的字符串，选完对不上。 */
const aliasOf = (model: { readonly provider: string; readonly id: string }): string =>
  `${model.provider}/${model.id}`

/*
 * 表由「此刻的配置 + 此刻的目录 + 两张清单」拼出来。顺序与 bridge.ts 的 readSelectors
 * 一致 —— 一致不是形式要求：屏幕靠顺序稳定来避免每帧重排。
 *
 * `thinkingOptions` 与 `skillSourceOf` 由调用方传入：两者的正本都住在 bridge.ts
 * （设置注册表里 defaultThinkingLevel 那格的 ui.options、五词来源折叠），本层再读一次
 * 就是第二份标签表。
 */
export async function buildExpectedState(input: {
  readonly registry: ModelRegistry
  readonly settings: Settings
  readonly skills: readonly {
    readonly name: string
    readonly description: string
    readonly filePath: string
    readonly source: string
    readonly hide?: boolean | undefined
  }[]
  readonly servers: readonly string[]
  readonly skillSourceOf: (source: string) => string
  readonly thinkingOptions: ReadonlyMap<string, { label: string; description?: string }>
}): Promise<ExpectedState> {
  const { registry, settings, skills, servers, skillSourceOf, thinkingOptions } = input
  const controls: SelectorControl[] = []

  const allowed = await resolveAllowedModels(registry, settings, getModelMatchPreferences(settings))
  const model = expectedModel(registry, settings, allowed)

  if (model !== undefined) {
    controls.push({
      id: 'model',
      purpose: 'model',
      current: aliasOf(model),
      choices: allowed.map((entry) => ({
        value: aliasOf(entry),
        label: entry.name ?? entry.id,
      })),
    })
  }

  /* 档位梯子取自**模型自己的元数据**：与会话上那份同一个产地，不写第二张四档通用表
     （ADR 0017）。正本是 @oh-my-pi/pi-catalog 的 src/model-thinking.ts 的 getSupportedEfforts
     （session/model-controls.ts:9 从同一处取）；pi-catalog 是 pi-coding-agent 的传递依赖，
     从本包解析不到它的子路径，所以那几行字段读法照抄在这里，正本升级时跟着改。 */
  const levels = model === undefined ? [] : supportedEfforts(model)
  const configured = settingValueOf(settings, 'defaultThinkingLevel')
  const modelDefault = model?.thinking?.defaultLevel

  if (levels.length > 0) {
    /*
     * 「此刻」必须与建会话之后**真正落定的那一档**一致，所以走 bridge.ts 收敛会话时
     * 用的**同一条判据**（thinkingToSettle），不自己再写一遍：
     *
     * 建会话时上游先按 pickInitialThinkingLevel 选一档（模型声明的 defaultLevel 优先 →
     * 全局 defaultThinkingLevel），随后整条会话被 settleThinking 收敛一次，而收敛用的
     * 全局值是 schema 默认（getDefault），不是用户配的那一格。
     *
     * 两者在 `defaultThinkingLevel: auto` 上分道：上游认 auto（sdk.ts:1676 起 autoThinking），
     * 但**本产品不出 auto 这一档**（thinking.ts 头部：每轮一次隐形的 judge 调用），所以
     * 收敛会把 auto 换成模型自己的默认档。此前这里自己退回「梯子最深一档」，报出的是 auto
     * 被夹掉的另一个值 —— 屏幕上一个永远不会到来的档位。
     */
    const start = modelDefault ?? (typeof configured === 'string' ? configured : undefined)
    const settled = thinkingToSettle(start, levels, modelDefault, globalThinkingDefault())
    /* `settled === undefined` 表示 start 本身就在梯子上；两者都没有时退最深一档兜底。 */
    const current = settled ?? start ?? (levels[levels.length - 1] as string)

    controls.push({
      id: 'thinking',
      purpose: 'thinking',
      current,
      choices: levels.map((level) => {
        const option = thinkingOptions.get(level)

        return {
          value: level,
          label: option?.label ?? level,
          ...(option?.description === undefined ? {} : { detail: option.description }),
        }
      }),
    })
  }

  const posture = EXPECTED_POSTURES.find(
    (entry) => entry.mode === settingValueOf(settings, 'tools.approvalMode'),
  )

  if (posture !== undefined) {
    controls.push({
      id: 'permission',
      purpose: 'permission',
      current: posture.value,
      choices: EXPECTED_POSTURES.map((entry) => ({ value: entry.value, label: entry.label })),
    })
  }

  /*
   * 计划与目标两格的「此刻」住在**会话对象**上（getPlanModeState / getGoalModeState），
   * 配置里没有它们的当前值，只有一个闸门（plan.enabled / goal.enabled）。
   *
   * 所以这里只能如实报会话的**起手值**：新建的会话没进过计划模式，就是 off；目标同理。
   *
   * 不能拿 plan.defaultOnStartup 当计划那一格的当前值 —— 上游只有 `interactive-mode.ts`
   * （shouldEnterPlanModeOnStartup，1851 行）与 `print-mode.ts` 读它，那是官方 TUI/CLI 的
   * 入口行为；桥走的是 `createAgentSession`，它一个字都不读这个开关（sdk.ts 里 plan 只有
   * 工具门那三处）。照配置报 on 会报出一个永远不会到来的状态，与权威态分叉。
   */
  if (settingValueOf(settings, 'plan.enabled') === true) {
    controls.push({
      id: 'plan',
      label: '计划',
      purpose: 'mode',
      current: 'off',
      choices: [
        { value: 'on', label: '计划', detail: '先只读探查并给出计划，批准后再动手' },
        { value: 'off', label: '直接执行', detail: '不先出计划，直接动手' },
      ],
    })
  }

  if (settingValueOf(settings, 'goal.enabled') === true) {
    controls.push({
      id: 'goal',
      label: '目标',
      purpose: 'mode',
      /* 开目标要有正文当 objective，而正文是用户下一句要打的话：收工由 prompt 一起交。 */
      appliesOnSubmit: true,
      current: 'off',
      choices: [
        { value: 'on', label: '目标', detail: '把它当作一个持续目标，达成前不中断' },
        { value: 'off', label: '不收目标', detail: '按普通一轮对话处理' },
      ],
    })
  }

  return {
    controls,
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      source: skillSourceOf(skill.source),
      kind: null,
      disableModelInvocation: skill.hide === true ? true : null,
    })),
    mcpServers: servers.map((name) => ({
      id: name,
      name,
      status: 'disconnected' as const,
      toolCount: 0,
      lastError: null,
    })),
  }
}

/*
 * 改一格期望态，返回这一格是**配置**还是**会话状态**。
 *
 * 只有模型与权限两格住配置里：改了立刻落盘，omp 自己热重载。计划与目标两格住在会话对象
 * 上（getPlanModeState / getGoalModeState），没有会话就无从落笔 —— 如实报 'session' 让
 * 调用方拒绝，而不是静默当成功（静默会让屏幕以为已经改了）。
 */
export async function applyExpectedSelection(input: {
  readonly settings: Settings
  readonly configId: string
  readonly value: string
}): Promise<'config' | 'session'> {
  const { settings, configId, value } = input

  switch (configId) {
    case 'model': {
      /* 写角色而不是写死 provider：omp 自己按这个角色解析（resolveModelRoleValue），
         我们这边再解析一次就是第二份语义。 */
      settings.setModelRole('default', value)
      await settings.flush()

      return 'config'
    }
    case 'permission': {
      const posture = EXPECTED_POSTURES.find((entry) => entry.value === value)

      if (posture === undefined) {
        throw new Error(`no approval posture is called ${value}`)
      }

      writeSettingValue(settings, 'tools.approvalMode', posture.mode)
      await settings.flush()

      return 'config'
    }
    case 'plan':
    case 'goal':
      return 'session'
    default:
      throw new Error(`no expected-state selector is called ${configId}`)
  }
}
