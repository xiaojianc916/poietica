/*
 * omp 内置命令交给宿主的那几句输出（`runtime.output`），折成给人看的中文。三种结局：
 *   - 结果已经在界面上别处体现（时间线的压缩行、标题、模型胶囊）→ null，不再推一块输出重复说；
 *   - 认得的句子 → 中文；
 *   - 认不出的（omp 新加的、报表类输出）→ 原样交回，宁可是英文也不吞掉。
 * 判据是 omp 的原句（builtin-lifecycle.ts / builtin-modes.ts / shake-types.ts，18.10.3）；omp 改了措辞，
 * 这里退回原样推，不会把一次失败说成成功。
 */

/** 已经由别处体现的成功结果：压缩 / 交接（时间线那一行）、改名（标题）、换模型（输入框的模型胶囊） */
const SHOWN_ELSEWHERE: readonly RegExp[] = [
  /^Compaction complete\b/,
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

/** `/shake` 的结果（formatShakeSummary 的几种句式） */
function shakeText(text: string): string | null {
  if (text === 'Nothing to shake.') return '没有可清理的大块内容'
  if (text === 'No images found in this session.') return '这条对话里没有图片'
  if (text === 'No thinking blocks found in this session.') return '这条对话里没有思考内容'
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
const EXACT: ReadonlyMap<string, string> = new Map([
  ['Handoff cancelled.', '已取消交接'],
  ['Handoff generation is already in progress.', '交接文档正在生成，请等它结束'],
  ['Wait for the current response to finish or abort it before handing off.', '请等当前回复结束（或先停止）再交接'],
  [
    'Could not generate a session title. Use /rename <title> to set one.',
    '没能自动生成标题，可以用 /rename 加上标题来设置',
  ],
  ['Session name not changed (a user-set name takes precedence).', '标题未更改：已有手动设置的标题'],
  ['No model is currently selected.', '还没有选择模型'],
])

const FAILED_VERB: Readonly<Record<string, string>> = {
  Compaction: '压缩失败',
  Handoff: '交接失败',
  Rename: '重命名失败',
}

/** 带变量的句子：模式 + 怎么说（捕获组按顺序交进来） */
const PATTERNS: readonly (readonly [RegExp, (...groups: string[]) => string])[] = [
  [
    /^(Compaction|Handoff|Rename) failed: ([\s\S]*)$/,
    (verb, reason) => `${FAILED_VERB[verb] ?? verb}：${reasonOf(reason)}`,
  ],
  [/^Current model: (\S+)$/, (model) => `当前模型：${model}`],
  [/^Unknown model: ([\s\S]+?)(?:\. Use ACP[\s\S]*)?$/, (model) => `找不到模型「${model}」`],
  [/^Failed to (?:set|switch) model: ([\s\S]*)$/, (reason) => `切换模型失败：${reasonOf(reason)}`],
]

/**
 * 一句命令输出该怎么给人看：null = 不推（结果已在别处体现）；否则交回要推的那句。
 * 每次 `runtime.output` 一句，多行报表（/context、/usage……）整块原样交回。
 */
export function commandOutputText(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || SHOWN_ELSEWHERE.some((pattern) => pattern.test(text))) return null
  const exact = EXACT.get(text)
  if (exact !== undefined) return exact
  for (const [pattern, say] of PATTERNS) {
    const hit = pattern.exec(text)
    if (hit !== null) return say(...hit.slice(1).map((group) => group ?? ''))
  }
  return shakeText(text) ?? text
}

/** 命令执行抛出来的错误（不经 runtime.output 的那条路）：认得的原因说中文，认不出的原样 */
export function commandErrorText(message: string): string {
  const translated = commandOutputText(message)
  if (translated !== null && translated !== message.trim()) return translated
  return reasonOf(message)
}
