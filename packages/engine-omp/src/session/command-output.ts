import type { CommandOutputTone } from '@poietica/engine'

/*
 * omp 内置命令交给宿主的那几句输出（`runtime.output`），折成给人看的中文，并定下色调（屏幕据此挑横幅的样子）。三种结局：
 *   - 结果已经在界面上别处体现（时间线的压缩行、标题、模型胶囊、重试那一轮）→ null，不再推一条重复说；
 *   - 认得的句子 → 中文 + 成功 / 提示 / 警告 / 错误；
 *   - 认不出的（omp 新加的、报表类输出）→ 原样交回、按「提示」，宁可是英文也不吞掉。
 * 判据是 omp 的原句（builtin-lifecycle.ts / builtin-modes.ts / builtin-collaboration.ts / shake-types.ts，18.12.6）；
 * omp 改了措辞，这里退回原样推、按提示，不会把一次失败说成成功。
 */

/** 一句要推给人的命令输出 */
export interface CommandOutput {
  readonly text: string
  readonly tone: CommandOutputTone
}

/** 已经由别处体现的成功结果：压缩 / 交接（时间线那一行）、改名（标题）、换模型（输入框的模型胶囊）、重试（新的一轮） */
const SHOWN_ELSEWHERE: readonly RegExp[] = [
  /^Compaction complete\b/,
  /* 重试那一轮就画在时间线上 */
  /^Retrying the last failed turn\.$/,
  /^Context handed off and compacted in place\.?$/,
  /^Session renamed to [\s\S]*\.$/,
  /^Model set to \S+\.$/,
  /^Session-only model: [\s\S]+\.$/,
]

/** 失败原因里认得的那几句（omp 抛的 Error 原文）；认不出的原样接在「…失败：」后面 */
const REASONS: readonly (readonly [RegExp, string])[] = [
  [/^Nothing to compact \(no messages yet\)$/, '还没有可压缩的对话'],
  [/^Nothing to compact \(session too small[^)]*\)$/, '对话还太短，没有可压缩的内容'],
  [/^Already compacted$/, '刚压缩过，没有新的内容可压缩'],
  [/^Compaction already in progress$/, '正在压缩上下文，请等它结束'],
  [/^No model (selected|available)[\s\S]*$/, '没有可用的模型'],
  [/^Compaction failed: no available model$/, '没有可用的模型'],
  [/^Nothing to hand off \(no messages yet\)$/, '还没有可交接的对话'],
  [/^Nothing to hand off \(already compacted\)$/, '刚压缩过，没有新的内容可交接'],
]

function reasonOf(raw: string): string {
  const text = raw.trim().replace(/\.$/, '')
  for (const [pattern, said] of REASONS) {
    if (pattern.test(text)) return said
  }
  return text
}

/** token 数说成 39.9K 这样的短写：与输入框上下文用量那一格同一条规则（conversation 的 formatTokens） */
export function shortTokens(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1000)}K`
  return `${scaled(value / 1_000_000)}M`
}

const info = (text: string): CommandOutput => ({ text, tone: 'info' })
const success = (text: string): CommandOutput => ({ text, tone: 'success' })
const warning = (text: string): CommandOutput => ({ text, tone: 'warning' })
const failure = (text: string): CommandOutput => ({ text, tone: 'error' })

/** `/shake` 的结果（formatShakeSummary 的几种句式）：没有可清理的是提示，清掉了是成功 */
function shakeOutput(text: string): CommandOutput | null {
  if (text === 'Nothing to shake.') return info('没有可清理的大块内容')
  if (text === 'No images found in this session.') return info('这条对话里没有图片')
  if (text === 'No thinking blocks found in this session.') return info('这条对话里没有思考内容')
  const said = shakeText(text)
  return said === null ? null : success(said)
}

function shakeText(text: string): string | null {
  const images = /^Dropped (\d+) images? from this session\.$/.exec(text)
  if (images !== null) return `已移除 ${images[1]} 张图片`
  const thinking = /^Dropped (\d+) thinking blocks? from this session(?: \(~(\d+) tokens freed\))?\.$/.exec(text)
  if (thinking !== null) {
    const freed = thinking[2] === undefined ? '' : `，释放约 ${shortTokens(Number(thinking[2]))} token`
    return `已移除 ${thinking[1]} 段思考内容${freed}`
  }
  const shook = /^Shook (.+) \(~(\d+) tokens freed\)\.$/.exec(text)
  if (shook !== null) {
    const parts = (shook[1] ?? '').split(' + ').map((part) => {
      const tools = /^(\d+) tool results?$/.exec(part)
      if (tools !== null) return `${tools[1]} 个工具结果`
      const blocks = /^(\d+) blocks?$/.exec(part)
      return blocks === null ? part : `${blocks[1]} 段大块内容`
    })
    return `已移除 ${parts.join('、')}，释放约 ${shortTokens(Number(shook[2]))} token`
  }
  return null
}

/** 整句认得的那几句（omp 的原句，不带变量） */
const EXACT: ReadonlyMap<string, CommandOutput> = new Map([
  ['Handoff cancelled.', info('已取消交接')],
  ['Handoff generation is already in progress.', warning('交接文档正在生成，请等它结束')],
  [
    'Wait for the current response to finish or abort it before handing off.',
    warning('请等当前回复结束（或先停止）再交接'),
  ],
  /* 屏幕在这条横幅上另给「手动改名」：不再教人敲 `/rename <标题>` */
  ['Could not generate a session title. Use /rename <title> to set one.', warning('没能自动生成标题')],
  ['Session name not changed (a user-set name takes precedence).', info('标题未更改：已有手动设置的标题')],
  ['No model is currently selected.', warning('还没有选择模型')],
  /* /retry */
  ['Nothing to retry.', warning('没有可重试的失败回复')],
  [
    'Wait for the current response to finish or abort it before retrying.',
    warning('请等当前回复结束（或先停止）再重试'),
  ],
  /* /fresh */
  [
    'Wait for the current response to finish or abort it before refreshing provider state.',
    warning('请等当前回复结束（或先停止）再重置连接'),
  ],
  /* /fast、/slow（builtin-modes.ts 的 runFastCommand / runSlowCommand） */
  ['Fast mode enabled.', success('已开启快速模式')],
  ['Fast mode disabled.', success('已关闭快速模式')],
  ['Ultrafast mode enabled.', success('已开启极速模式')],
  ['Fast mode is unavailable for the current model.', warning('当前模型不支持快速模式')],
  ['Ultrafast is unavailable for the current model.', warning('当前模型不支持极速模式')],
  [
    'The current model has no slow mode: /slow uses the flex tier on OpenAI/Google models and low priority on Anthropic subscriptions.',
    warning('当前模型不支持慢速模式（只有 OpenAI / Google 的 flex 档与 Anthropic 订阅的低优先级）'),
  ],
  ['Slow mode off.', success('已关闭慢速模式')],
  [
    'Slow mode on: requests use the flex tier (lower cost, higher latency).',
    success('已开启慢速模式：请求走 flex 档，更便宜、延迟更高'),
  ],
  /* /extended-context、/skillful */
  ['Extended context enabled.', success('已开启扩展上下文')],
  ['Extended context disabled.', success('已关闭扩展上下文')],
  ['Skill listing enabled for this session.', success('这条对话的系统提示里会列出可用技能')],
  ['Skill listing disabled for this session.', success('这条对话的系统提示里不再列出可用技能')],
  /* /advisor（builtin-collaboration.ts） */
  ['Advisor enabled.', success('已开启顾问')],
  ['Advisor disabled.', success('已关闭顾问')],
  [
    "Advisor setting enabled, but no model is assigned to the 'advisor' role.",
    warning('顾问已开启，但还没有给「顾问」角色指定模型'),
  ],
  ['Advisor is not active for this session.', info('这条对话没有启用顾问')],
])

const FAILED_VERB: Readonly<Record<string, string>> = {
  Compaction: '压缩失败',
  Handoff: '交接失败',
  Rename: '重命名失败',
}

const ON_OFF: Readonly<Record<string, string>> = { on: '开', off: '关', ultra: '极速' }
const onOff = (value: string): string => ON_OFF[value] ?? value

/** 带变量的句子：模式 + 怎么说（捕获组按顺序交进来） */
const PATTERNS: readonly (readonly [RegExp, (...groups: string[]) => CommandOutput])[] = [
  [
    /^(Compaction|Handoff|Rename) failed: ([\s\S]*)$/,
    (verb, reason) => failure(`${FAILED_VERB[verb] ?? verb}：${reasonOf(reason)}`),
  ],
  [/^Current model: (\S+)$/, (model) => info(`当前模型：${model}`)],
  [/^Unknown model: ([\s\S]+?)(?:\. Use ACP[\s\S]*)?$/, (model) => failure(`找不到模型「${model}」`)],
  [/^Failed to (?:set|switch) model: ([\s\S]*)$/, (reason) => failure(`切换模型失败：${reasonOf(reason)}`)],
  /* 开关的状态句（`status` 子命令）与 Anthropic 订阅的两种慢速说法 */
  [/^Fast mode is (on|off|ultra)\.$/, (value) => info(`快速模式：${onOff(value)}`)],
  [/^Slow mode is (on|off)\b[\s\S]*$/, (value) => info(`慢速模式：${onOff(value)}`)],
  [
    /^Slow mode on: [\s\S]*low priority[\s\S]*$/,
    () => success('已开启慢速模式：Claude 订阅到达会话额度后改用低优先级继续'),
  ],
  [/^Slow mode off: [\s\S]*$/, () => success('已关闭慢速模式')],
  [/^Extended context is (on|off)\.$/, (value) => info(`扩展上下文：${onOff(value)}`)],
  [/^Skill listing: (on|off)\b[\s\S]*$/, (value) => info(`技能列表：${onOff(value)}`)],
  [
    /^Fresh provider session started \((\d+) provider states? pruned\)\.$/,
    (count) => success(count === '0' ? '已重置与服务商的连接' : `已重置与服务商的连接（清掉 ${count} 份连接状态）`),
  ],
  /* 参数不对时 omp 回一句用法：命令面板已给出可选值，这里只把用法原样带上 */
  [/^Usage: (\/[\s\S]+)$/, (usage) => warning(`参数不对，用法：${usage}`)],
]

/**
 * 一句命令输出该怎么给人看：null = 不推（结果已在别处体现）；否则交回要推的那句与色调。
 * 每次 `runtime.output` 一句，多行报表（/context、/usage……）整块原样交回、按提示。
 */
export function commandOutputOf(raw: string): CommandOutput | null {
  const text = raw.trim()
  if (text === '' || SHOWN_ELSEWHERE.some((pattern) => pattern.test(text))) return null
  const exact = EXACT.get(text)
  if (exact !== undefined) return exact
  for (const [pattern, say] of PATTERNS) {
    const hit = pattern.exec(text)
    if (hit !== null) return say(...hit.slice(1).map((group) => group ?? ''))
  }
  return shakeOutput(text) ?? info(text)
}

/** 命令执行抛出来的错误（不经 runtime.output 的那条路）：一律按错误；认得的原因说中文，认不出的原样 */
export function commandErrorOf(message: string): CommandOutput {
  const translated = commandOutputOf(message)
  if (translated !== null && translated.text !== message.trim()) return failure(translated.text)
  return failure(reasonOf(message))
}
