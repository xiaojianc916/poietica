/**
 * omp 内置模型角色的中文名与说明。键是 omp 的角色 id（`modelRoles.<role>`，稳定标识符），中文只换「给人看的那一列」，
 * 与 settings-catalog.ts 同一做法：查不到就交回 null，由调用方用 omp 的原名兜底。说明照 omp 各读取点的实际用途写。
 */
const ROLE_TEXT: Readonly<Record<string, { readonly name: string; readonly description: string }>> = {
  default: { name: '默认', description: '新对话用的模型' },
  smol: { name: '快速', description: '轻量、要快的任务用的模型' },
  slow: { name: '深度思考', description: '难题、需要深度思考时用的模型' },
  vision: { name: '视觉', description: '读图用的模型' },
  plan: { name: '规划', description: '计划模式下写方案用的模型' },
  commit: { name: '提交', description: '写提交信息、变更摘要用的模型' },
  tiny: {
    name: '微型',
    description: '生成对话标题（标题生成器为「微型」或分叉生成失败时）与其它后台小事用的模型',
  },
  memory: { name: '记忆', description: '记忆整理与摘要用的模型' },
  task: { name: '子任务', description: '派发子代理任务时默认用的模型' },
  advisor: { name: '顾问', description: '顾问复核用的模型' },
  image: { name: '图像生成', description: '生成图片用的模型' },
  web: { name: '联网搜索', description: '联网搜索用的模型' },
  speech: { name: '语音合成', description: '朗读（TTS）用的模型' },
  dictation: { name: '语音转写', description: '听写（STT）用的模型' },
  judge: { name: '评判', description: '自动评判类判断用的模型' },
}

/** 某个角色给人看的名字与说明；`builtinName` 为 false（用户在 omp 里改过名）时名字交回 null，说明照给 */
export function roleTextOf(
  role: string,
  builtinName: boolean,
): { readonly name: string | null; readonly description: string | null } {
  const text = Object.hasOwn(ROLE_TEXT, role) ? ROLE_TEXT[role] : undefined
  return { name: builtinName ? (text?.name ?? null) : null, description: text?.description ?? null }
}
