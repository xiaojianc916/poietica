/**
 * omp 内置模型角色的中文名、说明与「没配时跟谁走」。键是 omp 的角色 id（`modelRoles.<role>`，稳定标识符），中文只换「给人看的
 * 那一列」，与 settings-catalog.ts 同一做法：查不到就交回 null，由调用方用 omp 的原名兜底。说明照 omp 各读取点的实际用途写。
 */
const ROLE_TEXT: Readonly<Record<string, { readonly name: string; readonly description: string }>> = {
  default: { name: '默认', description: '新对话使用的模型' },
  smol: { name: '快速', description: '简单、要求速度的任务' },
  slow: { name: '深度思考', description: '复杂问题与深度推理' },
  vision: { name: '视觉', description: '对话模型不支持图片时，用它读图' },
  plan: { name: '规划', description: '规划模式下撰写方案' },
  commit: { name: '提交', description: '生成提交信息与变更摘要' },
  tiny: { name: '微型', description: '生成对话标题等后台小任务' },
  memory: { name: '记忆', description: '整理与总结记忆' },
  task: { name: '子任务', description: '子代理执行任务' },
  advisor: { name: '顾问', description: '复核方案、给出第二意见' },
  widget: { name: '任务小组件', description: '撰写后台作业的小组件规格' },
  image: { name: '图像生成', description: '生成图片' },
  web: { name: '联网搜索', description: '搜索网页' },
  speech: { name: '语音合成', description: '朗读文本' },
  dictation: { name: '语音转写', description: '把语音转成文字' },
  judge: { name: '评判', description: '是非、分类等结构化判断' },
}

/** 某个角色给人看的名字与说明；`builtinName` 为 false（用户在 omp 里改过名）时名字交回 null，说明照给 */
export function roleTextOf(
  role: string,
  builtinName: boolean,
): { readonly name: string | null; readonly description: string | null } {
  const text = Object.hasOwn(ROLE_TEXT, role) ? ROLE_TEXT[role] : undefined
  return { name: builtinName ? (text?.name ?? null) : null, description: text?.description ?? null }
}

type Follow =
  /** `configuredOnly`：被跟的那一格自己配过才跟，否则 omp 走内置优先级（= auto） */
  { readonly kind: 'role'; readonly role: string; readonly configuredOnly: boolean } | { readonly kind: 'conversation' }

/*
 * 没配时 omp 实际的去向，逐条照 omp 18.12.6 的读取点：
 * - smol / slow：config/model-resolver 的 shouldInheritDefaultBeforePriority —— default 配了就继承它，没配走优先级表
 * - tiny → smol、memory → tiny、widget → smol、advisor → slow（仅 slow 配过）：同文件 ROLE_CONFIGURED_FALLBACK
 * - vision：utils/image-vision-fallback 依次试 `@vision` → `@default` → 当前模型
 * - commit：commit/model-selection 依次试 commit → smol → 其余对话角色
 * - plan：modes/interactive-mode 的 #applyPlanModeModel，plan 解析不出模型就不切，留在当前对话的模型上
 * - task：config/model-resolver 的 isSessionInheritedAgentPattern，`@task` 继承会话模型
 * 表里没有的（image / web / speech / dictation / judge 与自定义角色）由 omp 按内置优先级自己挑。
 */
const ROLE_FOLLOWS: Readonly<Record<string, Follow>> = {
  smol: { kind: 'role', role: 'default', configuredOnly: true },
  slow: { kind: 'role', role: 'default', configuredOnly: true },
  vision: { kind: 'role', role: 'default', configuredOnly: false },
  commit: { kind: 'role', role: 'smol', configuredOnly: false },
  tiny: { kind: 'role', role: 'smol', configuredOnly: false },
  memory: { kind: 'role', role: 'tiny', configuredOnly: false },
  advisor: { kind: 'role', role: 'slow', configuredOnly: true },
  widget: { kind: 'role', role: 'smol', configuredOnly: false },
  plan: { kind: 'conversation' },
  task: { kind: 'conversation' },
}

export type RoleFallback =
  | { readonly kind: 'role'; readonly role: string }
  | { readonly kind: 'conversation' }
  | { readonly kind: 'auto'; readonly model: string | null }

/** 某个角色没配时的去向；`autoPick` 只在落到 omp 自动挑选时才问（它要跑一遍 omp 的解析） */
export function roleFallbackOf(
  role: string,
  isConfigured: (role: string) => boolean,
  autoPick: () => string | null,
): RoleFallback {
  const follow = Object.hasOwn(ROLE_FOLLOWS, role) ? ROLE_FOLLOWS[role] : undefined
  if (follow?.kind === 'conversation') return { kind: 'conversation' }
  if (follow !== undefined && (!follow.configuredOnly || isConfigured(follow.role))) {
    return { kind: 'role', role: follow.role }
  }
  return { kind: 'auto', model: autoPick() }
}
