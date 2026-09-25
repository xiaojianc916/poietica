import type { ToolCallContent } from '../agent/tool-call'

/*
 * omp 工具调用的因地制宜视图。
 *
 * omp 没有 kap 那份 display 提示，入参与产出都是原始 JSON —— 直接画出来就是两坨
 * 大括号。但每个工具「这一格该画什么」是有标准答案的：读文件画文件内容，改动画
 * diff，命令画命令与输出，搜索画结果，截图画图。这张表就是那些标准答案，按工具名
 * 查，名字是 agent 报上来的那一个（BUILTIN_TOOL_NAMES），大小写不敏感。
 *
 * 认不出的名字交回空两面 —— 抽屉的兜底会按入参/产出的 JSON 重排（tool-call-facets
 * 的 bagOf / outputOf），与已知工具共用同一条降级路。这里只负责「认识」的工具。
 *
 * 产出的是 ToolCallContent（command / prose / text / diff / todo），上色与虚拟化归
 * tool-call-facets 与 tool-call-panels：这一层决定「画什么」，不决定「怎么画」。
 */

export interface OmpToolView {
  /** 折叠行上的主语：命令、路径、模式、地址。空表示交给词表或兜底。 */
  readonly subject: string
  readonly request: readonly ToolCallContent[]
  readonly response: readonly ToolCallContent[]
}

const NONE: readonly ToolCallContent[] = []

const text = (body: string): ToolCallContent => ({
  type: 'content',
  content: { type: 'text', text: body },
})
const prose = (body: string): ToolCallContent => ({ type: 'prose', text: body })
const command = (body: string, language: string): ToolCallContent => ({
  type: 'command',
  command: body,
  language,
})

/** 扩展名 → 围栏的 info string；认不出的就给空，让它按纯文本上色。 */
const LANGS: Readonly<Record<string, string>> = {
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml',
}

function langOf(path: string): string {
  const dot = path.lastIndexOf('.')

  return dot === -1 ? '' : (LANGS[path.slice(dot + 1).toLowerCase()] ?? '')
}

function field(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object') {
    return undefined
  }

  const value = Reflect.get(input, key)

  return typeof value === 'string' ? value : undefined
}

function firstLine(value: string): string {
  return value.split('\n')[0] ?? value
}

type OutputBlock = {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** omp 的产出信封：AgentToolResult 的 content 块。文本块接起来，图块折成 markdown 图。 */
function blocksOf(output: unknown): readonly OutputBlock[] {
  if (
    output !== null &&
    typeof output === 'object' &&
    Array.isArray(Reflect.get(output, 'content'))
  ) {
    return Reflect.get(output, 'content') as readonly OutputBlock[]
  }

  return []
}

function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') {
    return output
  }

  const joined = blocksOf(output)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')

  return joined === '' ? undefined : joined
}

function imageMarkdownOf(output: unknown): string | undefined {
  const images = blocksOf(output)
    .filter((block) => block.type === 'image' && typeof block.data === 'string')
    .map((block) => `![截图](data:${block.mimeType ?? 'image/png'};base64,${block.data})`)

  return images.length === 0 ? undefined : images.join('\n\n')
}

/** 一位工具视图的原料：入参、说回来的那句话（没有就是 undefined）、失败原因。 */
interface Ctx {
  readonly input: unknown
  readonly said: string | undefined
  readonly error: string | undefined
  /** 原始产出；只有要拆截图的工具有资格碰它。 */
  readonly output: unknown
}

type Handler = (ctx: Ctx) => OmpToolView

const pick = (ctx: Ctx, key: string): string | undefined => field(ctx.input, key)
const failed = (ctx: Ctx): boolean => ctx.error !== undefined && ctx.error !== ''
const saidText = (ctx: Ctx): readonly ToolCallContent[] =>
  ctx.said === undefined ? NONE : [text(ctx.said)]
const proseSaid = (ctx: Ctx): readonly ToolCallContent[] =>
  ctx.said === undefined ? NONE : [prose(ctx.said)]
const failOr = (ctx: Ctx, body: readonly ToolCallContent[]): readonly ToolCallContent[] =>
  failed(ctx) ? [text(ctx.error ?? '这次调用失败了。')] : body

const bashView: Handler = (ctx) => {
  const commandText = pick(ctx, 'command') ?? ''

  return {
    subject: firstLine(commandText),
    request: [command(commandText, 'bash')],
    response: failOr(ctx, saidText(ctx)),
  }
}

const readView: Handler = (ctx) => {
  const path = pick(ctx, 'path') ?? ''
  const body = ctx.said === undefined ? NONE : [command(ctx.said, langOf(path))]

  return { subject: path, request: [prose(`读取 \`${path}\``)], response: failOr(ctx, body) }
}

const writeView: Handler = (ctx) => {
  const path = pick(ctx, 'path') ?? ''
  const body = pick(ctx, 'content')
  const request =
    body === undefined
      ? [prose(`写入 \`${path}\``)]
      : [prose(`写入 \`${path}\``), command(body, langOf(path))]

  return { subject: path, request, response: failOr(ctx, saidText(ctx)) }
}

const editView: Handler = (ctx) => {
  const path = pick(ctx, 'path') ?? ''
  const oldText = pick(ctx, 'oldText') ?? pick(ctx, 'old_string')
  const newText = pick(ctx, 'newText') ?? pick(ctx, 'new_string')
  const request =
    oldText !== undefined && newText !== undefined
      ? [{ type: 'diff' as const, path, oldText, newText } satisfies ToolCallContent]
      : [prose(`编辑 \`${path}\``)]

  return { subject: path, request, response: failOr(ctx, saidText(ctx)) }
}

const globView: Handler = (ctx) => {
  const pattern = pick(ctx, 'path') ?? pick(ctx, 'pattern') ?? ''

  return {
    subject: pattern,
    request: [prose(`按模式找文件：\`${pattern}\``)],
    response: failOr(ctx, saidText(ctx)),
  }
}

const grepView: Handler = (ctx) => {
  const pattern = pick(ctx, 'pattern') ?? ''
  const where = pick(ctx, 'path') ?? '.'

  return {
    subject: pattern,
    request: [prose(`在 \`${where}\` 里搜索 ${pattern}`)],
    response: failOr(ctx, saidText(ctx)),
  }
}

const evalView: Handler = (ctx) => {
  const code = pick(ctx, 'code') ?? ''

  return {
    subject: firstLine(code),
    request: [command(code, 'javascript')],
    response: failOr(ctx, saidText(ctx)),
  }
}

/*
 * 浏览器与桌面控制是 eval prelude 的操作面，走的也是工具调用这条路：画代码与产出，
 * 产出里带截图就折成 markdown 图，屏幕上直接看得到那一帧。
 */
const browserView: Handler = (ctx) => {
  const action = pick(ctx, 'action') ?? ''
  const code = pick(ctx, 'code')
  const chain =
    ctx.input !== null && typeof ctx.input === 'object'
      ? Reflect.get(ctx.input, 'chain')
      : undefined
  const body = code ?? (chain === undefined ? '' : JSON.stringify(chain, null, 2))
  const shots = imageMarkdownOf(ctx.output)
  const response = failOr(ctx, saidText(ctx))

  return {
    subject: [action, firstLine(body)].filter(Boolean).join(' · '),
    request: [command(body, 'javascript')],
    response: shots === undefined ? response : [...response, prose(shots)],
  }
}

const proseInOut =
  (subjectOf: (ctx: Ctx) => string): Handler =>
  (ctx) => {
    const subject = subjectOf(ctx)

    return {
      subject: firstLine(subject),
      request: [prose(subject)],
      response: failOr(ctx, proseSaid(ctx)),
    }
  }

const searchView = proseInOut((ctx) => pick(ctx, 'query') ?? pick(ctx, 'search') ?? '')
const githubView = proseInOut((ctx) => pick(ctx, 'url') ?? '')
const taskView = proseInOut(
  (ctx) => pick(ctx, 'description') ?? pick(ctx, 'prompt') ?? pick(ctx, 'task') ?? '',
)
const askView = proseInOut((ctx) => pick(ctx, 'question') ?? pick(ctx, 'prompt') ?? '')

const todoView: Handler = (ctx) => {
  const op = pick(ctx, 'op') ?? ''
  const items =
    ctx.input !== null && typeof ctx.input === 'object'
      ? Reflect.get(ctx.input, 'items')
      : undefined
  const task = pick(ctx, 'task')
  const request =
    op === 'init' && Array.isArray(items)
      ? [
          {
            type: 'todo' as const,
            items: items
              .filter((value): value is string => typeof value === 'string')
              .map((title) => ({ title, status: 'pending' as const })),
          } satisfies ToolCallContent,
        ]
      : task !== undefined
        ? [prose(`追加任务：${task}`)]
        : [prose('查看任务清单')]

  return { subject: op, request, response: failOr(ctx, proseSaid(ctx)) }
}

const lspView: Handler = (ctx) => {
  const path = pick(ctx, 'path') ?? ''

  return {
    subject: path,
    request: [prose(path === '' ? '读取语言服务诊断' : `读取 \`${path}\` 的诊断`)],
    response: failOr(ctx, saidText(ctx)),
  }
}

const waitView: Handler = (ctx) => {
  const duration = pick(ctx, 'duration') ?? pick(ctx, 'seconds') ?? ''

  return {
    subject: duration === '' ? '等待' : `等待 ${duration}`,
    request: NONE,
    response: saidText(ctx),
  }
}

const checkpointView: Handler = (ctx) => {
  const summary = pick(ctx, 'description') ?? pick(ctx, 'summary') ?? ''

  return {
    subject: summary,
    request: summary === '' ? NONE : [prose(summary)],
    response: saidText(ctx),
  }
}

/*
 * 按工具名查（小写）。find / glob 的模式住在 path 字段里；grep 的 pattern 才是模式。
 */
const HANDLERS: Readonly<Record<string, Handler>> = {
  bash: bashView,
  read: readView,
  write: writeView,
  browser: browserView,
  computer: browserView,
  checkpoint: checkpointView,
  edit: editView,
  ast_edit: editView,
  eval: evalView,
  find: globView,
  glob: globView,
  grep: grepView,
  ast_grep: grepView,
  github: githubView,
  web_search: searchView,
  task: taskView,
  todo: todoView,
  ask: askView,
  lsp: lspView,
  wait: waitView,
  rewind: checkpointView,
}

export function ompToolView(
  name: string,
  input: unknown,
  output: unknown,
  error?: string,
): OmpToolView {
  const handler = HANDLERS[name.toLowerCase()]

  if (handler === undefined) {
    return { subject: '', request: NONE, response: NONE }
  }

  return handler({ input, said: textOf(output), error, output })
}
