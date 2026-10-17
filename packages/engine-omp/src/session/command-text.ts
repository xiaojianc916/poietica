/**
 * 内置斜杠命令给人看的那两列（说明、参数提示）的中文，以及命令面板里的先后。键是 omp 的命令名（稳定标识符），
 * 不是英文说明（会改词的散文）。查不到的命令把 omp 的原文原样交回 —— omp 新加一条命令，面板照样有它，只是说明是英文。
 *
 * 参数提示里 `<…>` 是必填、`[…]` 是可选（omp 自己的写法，面板据此决定回车是直接执行还是先补参数）；
 * 子命令、开关值这类要原样敲进去的词不译。
 *
 * 表的先后就是面板的先后：常用的在前，按用途排（对话 → 模型与模式 → 任务与工具 → 扩展）。
 */
interface CommandText {
  readonly description: string
  readonly hint?: string
}

const COMMAND_TEXT: ReadonlyMap<string, CommandText> = new Map<string, CommandText>([
  /* 对话与上下文 */
  ['compact', { description: '把较早的对话压缩成摘要，腾出上下文', hint: '[关注点]' }],
  ['handoff', { description: '把对话整理成交接摘要，并就地压缩上下文', hint: '[交接重点]' }],
  ['shake', { description: '移除工具输出等大块内容，释放上下文' }],
  ['retry', { description: '重试上一轮失败的回复' }],
  ['context', { description: '查看上下文用量明细' }],
  ['rename', { description: '重命名对话，不填标题则自动生成', hint: '[标题]' }],
  ['fresh', { description: '重置与服务商的连接状态，对话记录不变' }],
  ['export', { description: '把对话导出为 HTML 文件', hint: '[路径]' }],
  ['dump', { description: '以纯文本输出完整对话记录' }],
  ['share', { description: '生成加密的分享链接' }],
  /* omp 随包带的工作流命令（不是 omp 的内置表，但对人来说同样是内置） */
  ['review', { description: '审查代码改动', hint: '[审查要求]' }],
  ['init', { description: '为当前代码库生成 AGENTS.md' }],
  ['green', { description: '反复修复 CI 失败，直到分支通过' }],
  ['annotate', { description: '批注改动、文件或最近一条回复', hint: '[目标]' }],
  /* 模型与模式 */
  ['model', { description: '查看当前的模型设置' }],
  ['switch', { description: '只为这条对话切换模型', hint: '[模型]' }],
  ['effort', { description: '设置或查看推理强度', hint: '[档位]' }],
  ['fast', { description: '开关快速模式', hint: '[on|ultra|off]' }],
  ['slow', { description: '开关慢速模式', hint: '[on|off]' }],
  ['modelpreset', { description: '保存或切换模型预设', hint: '[list|save|switch|delete]' }],
  ['advisor', { description: '开关顾问：另一个模型审阅每一轮并给出建议', hint: '[on|off|status]' }],
  ['prewalk', { description: '让另一个模型接手下一轮（设置、重来或取消）', hint: '[restart|off]' }],
  ['extended-context', { description: '开关扩展上下文窗口', hint: '[on|off]' }],
  ['skillful', { description: '开关：在系统提示里列出可用技能', hint: '[on|off]' }],
  ['computer', { description: '开关电脑控制', hint: '[on|off]' }],
  ['browser', { description: '切换浏览器为后台运行或可见窗口', hint: '[headless|visible]' }],
  ['force', { description: '让下一轮必须使用指定工具', hint: '<工具名> [要求]' }],
  /* 任务、目录与工具 */
  ['todo', { description: '查看或修改待办清单', hint: '<子命令>' }],
  ['jobs', { description: '查看后台任务', hint: '[full|kill]' }],
  ['tools', { description: '查看 agent 当前可用的工具' }],
  ['usage', { description: '查看用量与额度', hint: '[show|reset]' }],
  ['session', { description: '查看或设置当前会话', hint: '[info|pin]' }],
  ['dirs', { description: '列出这条对话的工作目录' }],
  ['add-dir', { description: '为这条对话添加工作目录', hint: '<路径>' }],
  ['remove-dir', { description: '从这条对话移除工作目录', hint: '<路径>' }],
  ['memory', { description: '查看与维护记忆', hint: '<子命令>' }],
  ['security', { description: '规划、运行与比较安全扫描', hint: '<子命令>' }],
  ['ratchet', { description: '为一段 LLM 流程建立评测，并自动迭代优化', hint: '[流程与目标]' }],
  /* 扩展 */
  ['mcp', { description: '管理 MCP 服务器', hint: '<子命令>' }],
  ['plugins', { description: '管理已安装的插件', hint: '[list|enable|disable]' }],
  ['marketplace', { description: '从插件市场安装与管理插件', hint: '<子命令>' }],
  ['reload-plugins', { description: '重新加载全部插件' }],
  ['ssh', { description: '管理 SSH 连接', hint: '<子命令>' }],
  ['changelog', { description: '查看更新日志', hint: '[full|last]' }],
])

const ORDER: ReadonlyMap<string, number> = new Map([...COMMAND_TEXT.keys()].map((name, at) => [name, at]))

/** 内置命令的中文说明；查不到交回 omp 原文 */
export function builtinDescriptionOf(name: string, fallback: string | null): string | null {
  return COMMAND_TEXT.get(name)?.description ?? fallback
}

/** 内置命令的参数提示（面板里紧跟名字的那一格，只写最常用的形状）；表里没写的交回 omp 原文（通常也是 null） */
export function builtinHintOf(name: string, fallback: string | null): string | null {
  const text = COMMAND_TEXT.get(name)
  if (text === undefined) return fallback
  return text.hint ?? null
}

/** 面板里的先后：表里的按表排，表外的（omp 新加的）排在后面、保持 omp 的次序 */
export function builtinRankOf(name: string): number {
  return ORDER.get(name) ?? ORDER.size
}
