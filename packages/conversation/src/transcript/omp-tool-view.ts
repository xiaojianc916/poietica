import type { ToolCallContent, ToolDrawerShape, ToolKind } from '../agent/tool-call'
import { describeTool } from './tool-vocabulary'

// omp 工具调用的因地制宜视图：按工具名查标准答案，认不出的交回空视图由调用方兜底。
// 产出优先于入参（edit/read 的真实内容在产出 details 里）；图片在出口统一追加。

export type { ToolDrawerShape }

export interface OmpToolView {
  readonly known: boolean
  readonly kind: ToolKind
  readonly headline: string
  readonly subject: string
  readonly shape: ToolDrawerShape
  readonly background: boolean
  readonly request: readonly ToolCallContent[]
  readonly response: readonly ToolCallContent[]
}

const NONE: readonly ToolCallContent[] = []

const text = (body: string): ToolCallContent => ({
  type: 'content',
  content: { type: 'text', text: body },
})
const prose = (body: string): ToolCallContent => ({ type: 'prose', text: body })
const code = (body: string, language: string): ToolCallContent => ({
  type: 'command',
  command: body,
  language,
})

const LINE_CAP = 120

function oneLine(value: string): string {
  const cut = value.indexOf('\n')
  const said = (cut === -1 ? value : value.slice(0, cut)).trim()

  return said.length > LINE_CAP ? `${said.slice(0, LINE_CAP)}…` : said
}

// 反斜杠才不会被 markdown 当转义吃掉。
const at = (value: string): string => `\`${value}\``

function join(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
}

function dot(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ')
}

// read 的路径可能带选择器（src/a.ts:10-20），扩展名要在冒号前收住。
const LANGS: Readonly<Record<string, string>> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  dockerfile: 'docker',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  pl: 'perl',
  ps1: 'powershell',
  py: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

function langOf(path: string): string {
  const dot = path.lastIndexOf('.')

  if (dot === -1) {
    return ''
  }

  const cut = path.indexOf(':', dot)
  const extension = (cut === -1 ? path.slice(dot + 1) : path.slice(dot + 1, cut)).toLowerCase()

  return LANGS[extension] ?? ''
}

function bag(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// 唯一读 unknown 对象的地方：noPropertyAccessFromIndexSignature 下 bag(x).y 不合法。
const get = (value: unknown, key: string): unknown => bag(value)?.[key]

const pick = (input: unknown, key: string): string | undefined => {
  const value = get(input, key)

  return typeof value === 'string' && value !== '' ? value : undefined
}

const numb = (input: unknown, key: string): number | undefined => {
  const value = get(input, key)

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const flag = (input: unknown, key: string): boolean => get(input, key) === true

const list = (input: unknown, key: string): readonly unknown[] => {
  const value = get(input, key)

  return Array.isArray(value) ? value : NONE
}

const NO_STRINGS: readonly string[] = []

function strings(input: unknown, key: string): readonly string[] {
  const value = get(input, key)

  if (typeof value === 'string') {
    return value === '' ? NO_STRINGS : [value]
  }

  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one !== '')
    : NO_STRINGS
}

type Block = {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

function blocksOf(output: unknown): readonly Block[] {
  const held = get(output, 'content')

  return Array.isArray(held) ? (held as readonly Block[]) : NONE
}

function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') {
    return output === '' ? undefined : output
  }

  const joined = blocksOf(output)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')

  return joined === '' ? undefined : joined
}

function imagesOf(output: unknown): readonly ToolCallContent[] {
  return blocksOf(output)
    .filter((block) => block.type === 'image' && typeof block.data === 'string')
    .map((block) => ({
      type: 'content' as const,
      content: {
        type: 'image' as const,
        data: block.data as string,
        mimeType: block.mimeType ?? 'image/png',
      },
    }))
}

const detailsOf = (output: unknown): unknown => get(output, 'details')

interface Ctx {
  readonly input: unknown
  readonly details: unknown
  readonly said: string | undefined
  // xd:// 设备委派要拿它的 content 块当被调工具的产出。
  readonly output: unknown
  readonly error: string | undefined
}

type Handler = (ctx: Ctx) => OmpToolView

const failed = (ctx: Ctx): boolean => ctx.error !== undefined && ctx.error !== ''
const saidText = (ctx: Ctx): readonly ToolCallContent[] =>
  ctx.said === undefined ? NONE : [text(ctx.said)]
const proseSaid = (ctx: Ctx): readonly ToolCallContent[] =>
  ctx.said === undefined ? NONE : [prose(ctx.said)]
// 失败时那一句顶替产出。
const failOr = (ctx: Ctx, body: readonly ToolCallContent[]): readonly ToolCallContent[] =>
  failed(ctx) ? [text(ctx.error ?? '这次调用失败了。')] : body

function view(
  kind: ToolKind,
  headline: string,
  subject: string,
  request: readonly ToolCallContent[],
  response: readonly ToolCallContent[],
  shape: ToolDrawerShape = 'flow',
): OmpToolView {
  return { known: true, kind, headline, subject, shape, background: false, request, response }
}

// 非零退出码与超时不在折叠行上报，落在产出那面。
const bashView: Handler = (ctx) => {
  const command = pick(ctx.input, 'command') ?? ''
  const exit = numb(ctx.details, 'exitCode')
  const foot =
    flag(ctx.details, 'timedOut') === true
      ? [prose('命令超时被杀。')]
      : exit === undefined || exit === 0
        ? NONE
        : [prose(`退出码 ${String(exit)}`)]

  return view(
    'execute',
    oneLine(command) || '执行命令',
    oneLine(command),
    [code(command, 'bash')],
    failOr(ctx, [...saidText(ctx), ...foot]),
  )
}

// 给人看的原始正文在 details.displayContent.text（hashline 模式下入参带行号前缀）。
const readView: Handler = (ctx) => {
  const path = pick(ctx.input, 'path') ?? pick(ctx.details, 'resolvedPath') ?? ''
  const shown = pick(get(ctx.details, 'displayContent'), 'text') ?? ctx.said
  const conflict = numb(ctx.details, 'conflictCount')

  return view(
    'read',
    path === '' ? '读取文件' : `阅读 ${path}`,
    path,
    NONE,
    failOr(ctx, [
      ...(shown === undefined ? NONE : [code(shown, langOf(path))]),
      ...(conflict === undefined || conflict === 0
        ? NONE
        : [prose(`这个文件有 ${String(conflict)} 处未解决的冲突。`)]),
    ]),
    'result',
  )
}

// write 还是 xd:// 传输本身：omp 把可挂载工具收进 write xd://<tool>，
// 一次 write 其实是在调另一个工具，按被调的那个工具画，否则永远显示成「写入 xd://browser」。
const writeView: Handler = (ctx) => {
  const path = pick(ctx.input, 'path') ?? pick(ctx.details, 'resolvedPath') ?? ''
  const device = bag(get(ctx.details, 'xdev'))
  const tool = pick(device, 'tool')

  // read/write 是传输本身，不会是被挂载的设备。
  if (
    tool !== undefined &&
    tool !== 'read' &&
    tool !== 'write' &&
    pick(device, 'mode') !== 'help'
  ) {
    const inner = get(device, 'inner')
    const args = get(device, 'args')
    const invoked = ompToolView(tool, args, { content: blocksOf(ctx.output), details: inner })

    return {
      ...invoked,
      headline: invoked.headline === '' ? `xd://${tool}` : `xd://${tool} · ${invoked.headline}`,
      subject: invoked.subject === '' ? tool : invoked.subject,
    }
  }

  const body = pick(ctx.input, 'content')
  const head = flag(ctx.details, 'madeExecutable') ? '写入并标记可执行' : '写入'

  return view(
    'write',
    join(head, path) || head,
    path,
    body === undefined ? NONE : [code(body, langOf(path))],
    failOr(ctx, saidText(ctx)),
  )
}

// hashline 模式下入参只有一段补丁正文，真正的结构在产出 details 里（source of truth）。
function editDiffs(ctx: Ctx): readonly ToolCallContent[] {
  const held = ctx.details
  const many = get(held, 'perFileResults')

  if (Array.isArray(many)) {
    return many.flatMap((entry) => {
      const path = pick(entry, 'path')
      const newText = pick(entry, 'newText')

      return path === undefined || newText === undefined
        ? NONE
        : [
            {
              type: 'diff' as const,
              path,
              ...(pick(entry, 'oldText') === undefined ? {} : { oldText: pick(entry, 'oldText') }),
              newText,
            },
          ]
    })
  }

  const path = pick(held, 'path') ?? pick(ctx.input, 'path')
  const newText =
    pick(held, 'newText') ?? pick(ctx.input, 'newText') ?? pick(ctx.input, 'new_string')

  if (path === undefined || newText === undefined) {
    return NONE
  }

  const oldText =
    pick(held, 'oldText') ?? pick(ctx.input, 'oldText') ?? pick(ctx.input, 'old_string')

  return [{ type: 'diff' as const, path, ...(oldText === undefined ? {} : { oldText }), newText }]
}

// 交不出新旧正文时：先退回产出自己算好的统一 diff，再是入参补丁正文。
function editPatch(ctx: Ctx): readonly ToolCallContent[] {
  const diff = pick(ctx.details, 'diff')
  const patch = pick(ctx.input, 'input')

  if (diff !== undefined) {
    return [code(diff, 'diff')]
  }

  return patch === undefined ? NONE : [code(patch, 'diff')]
}

const EDIT_HEADS: Readonly<Record<string, string>> = {
  create: '新建',
  delete: '删除',
  update: '编辑',
}

function editOp(ctx: Ctx): string | undefined {
  const top = pick(ctx.details, 'op')

  if (top !== undefined) {
    return top
  }

  const many = get(ctx.details, 'perFileResults')

  return Array.isArray(many) ? pick(many[0], 'op') : undefined
}

const editView: Handler = (ctx) => {
  const path =
    pick(ctx.input, 'path') ?? pick(ctx.details, 'path') ?? pick(ctx.details, 'resolvedPath') ?? ''
  const diffs = editDiffs(ctx)
  const patch = editPatch(ctx)
  const request =
    diffs.length > 0
      ? diffs
      : patch.length > 0
        ? patch
        : path === ''
          ? NONE
          : [prose(`编辑 ${at(path)}`)]
  const head = join(EDIT_HEADS[editOp(ctx) ?? ''] ?? '编辑', path === '' ? undefined : path)
  const moved = pick(ctx.details, 'move')

  return view(
    'edit',
    head === '' ? '编辑文件' : head,
    path,
    request,
    failOr(ctx, [
      ...(moved === undefined ? NONE : [prose(`重命名为 ${at(moved)}`)]),
      ...saidText(ctx),
    ]),
    'diff',
  )
}

const astEditView: Handler = (ctx) => {
  const where = strings(ctx.input, 'paths').join('、')
  const ops = list(ctx.input, 'ops')
  const pats = ops
    .map((entry) => pick(entry, 'pat'))
    .filter((entry): entry is string => entry !== undefined)
  const request =
    pats.length === 0
      ? NONE
      : [code(pats.map((pat, index) => `${String(index + 1)}. ${pat}`).join('\n'), 'text')]
  const subject = where === '' ? `${String(ops.length)} 处` : where

  return view('edit', `AST 改写 ${subject}`, subject, request, failOr(ctx, saidText(ctx)))
}

const grepView: Handler = (ctx) => {
  const pattern = pick(ctx.input, 'pattern') ?? ''
  const where = pick(ctx.input, 'path') ?? pick(ctx.details, 'searchPath') ?? '.'
  const count = numb(ctx.details, 'matchCount')

  return view(
    'search',
    `搜索 ${pattern}`,
    pattern,
    [prose(`在 ${at(where)} 里匹配 ${at(pattern)}`)],
    failOr(ctx, [
      ...saidText(ctx),
      ...(count === undefined ? NONE : [prose(`${String(count)} 处匹配`)]),
    ]),
    'result',
  )
}

const astGrepView: Handler = (ctx) => {
  const pat = pick(ctx.input, 'pat') ?? ''
  const where = pick(ctx.input, 'path') ?? '.'

  return view(
    'search',
    `AST 搜索 ${pat}`,
    pat,
    [prose(`在 ${at(where)} 里按 AST 模式匹配 ${at(pat)}`)],
    failOr(ctx, saidText(ctx)),
    'result',
  )
}

// glob 的模式住在 path 字段里。
const globView: Handler = (ctx) => {
  const pattern = pick(ctx.input, 'path') ?? ''
  const count = numb(ctx.details, 'fileCount')

  return view(
    'search',
    `按模式查找 ${pattern}`,
    pattern,
    [prose(`按 ${at(pattern)} 找文件`)],
    failOr(ctx, [
      ...saidText(ctx),
      ...(count === undefined ? NONE : [prose(`${String(count)} 个文件`)]),
    ]),
    'result',
  )
}

const findView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''
  const where = pick(ctx.input, 'path')
  const hits = list(ctx.details, 'hits').length

  return view(
    'search',
    `语义查找 ${query}`,
    query,
    [
      prose(
        join(`按行为描述找 ${at(query)}`, where === undefined ? undefined : `范围 ${at(where)}`),
      ),
    ],
    failOr(ctx, [...saidText(ctx), ...(hits === 0 ? NONE : [prose(`命中 ${String(hits)} 处`)])]),
    'result',
  )
}

const LSP_ACTIONS: Readonly<Record<string, string>> = {
  capabilities: '查看能力',
  code_actions: '取代码动作',
  definition: '跳转定义',
  diagnostics: '读取诊断',
  hover: '查看悬停',
  implementation: '找实现',
  references: '找引用',
  reload: '重启服务',
  rename: '重命名',
  rename_file: '重命名文件',
  request: '发原始请求',
  status: '查看状态',
  symbols: '列符号',
  type_definition: '跳转类型定义',
}

const lspView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const file = pick(ctx.input, 'file') ?? ''
  const symbol = pick(ctx.input, 'symbol') ?? pick(ctx.input, 'query') ?? ''
  const said = LSP_ACTIONS[action] ?? '语言服务请求'
  const subject = dot(file, symbol)

  return view(
    'read',
    join(said, subject) || said,
    subject,
    [prose(join(`${at(file === '' ? '.' : file)} 上${said}`, pick(ctx.details, 'serverName')))],
    failOr(ctx, saidText(ctx)),
    'result',
  )
}

const EVAL_LANGS: Readonly<Record<string, string>> = { js: 'javascript', py: 'python' }

/*
 * eval 里那些不是代码的动作名。
 *
 * `browser` 与 `computer` 不是顶层工具 —— 它们是注入 eval 内核的作用域对象（omp 的
 * tools/browser.ts 与 tools/computer.ts 的 createBrowserPrelude / createComputerPrelude，
 * 经 eval/preludes.ts 注册）。模型写 `browser.open(...)` / `desktop.click(...)`，每一次
 * 调用都在 eval 的产出里留一条状态事件：details.statusEvents = `[{ op, detail }]`，
 * op 就是 prelude 名，detail 是上游自己写的那句话（如 `open main https://…`）。
 *
 * 所以这里要把它们挑出来单独说 —— 一次「用浏览器打开某页」在屏幕上不该只显示成
 * 「运行 JavaScript」。
 */
const PRELUDE_NAMES: Readonly<Record<string, string>> = {
  browser: '浏览器',
  computer: '桌面控制',
}

/** 这次 eval 调了哪些 prelude，各做了什么。 */
function preludesOf(ctx: Ctx): readonly string[] {
  const said: string[] = []
  /* 事件既可能挂在整次调用上，也可能挂在产生它的那个 cell 上。 */
  const events = [...list(ctx.details, 'statusEvents')]

  for (const cell of list(ctx.details, 'cells')) {
    events.push(...list(cell, 'statusEvents'))
  }

  for (const event of events) {
    const op = pick(event, 'op')
    const label = op === undefined ? undefined : PRELUDE_NAMES[op]

    if (label === undefined) {
      continue
    }

    const detail = pick(event, 'detail')

    said.push(join(label, detail) || label)
  }

  return said
}

const evalView: Handler = (ctx) => evalCall(ctx, pick(ctx.input, 'language') ?? 'js')

/*
 * eval 的别名（官方视图表把 js / python / notebook 都指到同一个渲染器）：名字本身
 * 就说了语言，所以入参里没有 language 时按别名来，而不是一律落回 JavaScript。
 */
const evalAlias =
  (language: string): Handler =>
  (ctx) =>
    evalCall(ctx, pick(ctx.input, 'language') ?? language)

function evalCall(ctx: Ctx, language: string): OmpToolView {
  const named = language === 'py' ? 'Python' : 'JavaScript'
  const body = pick(ctx.input, 'code') ?? ''
  const title = pick(ctx.input, 'title')
  const cells = list(ctx.details, 'cells')
  // 后端自己的 cells 才是真正跑过的那几段（一个 eval 可以带多个 cell）。
  const request =
    cells.length === 0
      ? [code(body, EVAL_LANGS[language] ?? '')]
      : cells.map((entry) => code(pick(entry, 'code') ?? '', EVAL_LANGS[language] ?? ''))
  /*
   * 那一行字说这次到底在做什么：调了 prelude 就报那件事（「浏览器 打开 main https://x」），
   * 否则才退回「运行 JavaScript」。两者都报会把一次浏览器动作说成一次脚本运行。
   */
  const preludes = preludesOf(ctx)
  const head =
    preludes.length > 0 ? preludes.join('；') : dot(`运行 ${named}`, title ?? oneLine(body))

  return view(
    'execute',
    head,
    preludes[0] ?? title ?? oneLine(body),
    request,
    failOr(ctx, saidText(ctx)),
  )
}

const BROWSER_ACTIONS: Readonly<Record<string, string>> = {
  call: '调用标签页',
  close: '关闭标签页',
  open: '打开',
  run: '执行脚本',
  tabs: '列出标签页',
}

const browserView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const name = pick(ctx.input, 'name') ?? 'main'
  const url = pick(ctx.input, 'url') ?? pick(ctx.details, 'url')
  const chain = get(ctx.input, 'chain')
  const script =
    pick(ctx.input, 'code') ??
    pick(ctx.input, 'fn') ??
    (chain === undefined ? undefined : JSON.stringify(chain, null, 2))
  const shots = list(ctx.details, 'screenshots').length
  const place = url === undefined ? name : url
  const head = BROWSER_ACTIONS[action] ?? action

  return view(
    'fetch',
    join('浏览器', head, place) || '浏览器',
    dot(action, place),
    script === undefined ? NONE : [code(script, 'javascript')],
    failOr(ctx, [...saidText(ctx), ...(shots === 0 ? NONE : [prose(`${String(shots)} 张截图`)])]),
  )
}

const COMPUTER_ACTIONS: Readonly<Record<string, string>> = {
  call: '调用桌面接口',
  capabilities: '查看能力',
  close: '关闭会话',
  run: '执行脚本',
}

const computerView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const chain = get(ctx.input, 'chain')
  const script =
    pick(ctx.input, 'code') ??
    pick(ctx.input, 'fn') ??
    (chain === undefined ? undefined : JSON.stringify(chain, null, 2))
  const shots = list(ctx.details, 'screenshots').length
  const head = COMPUTER_ACTIONS[action] ?? action

  return view(
    'execute',
    `桌面控制 · ${head}`,
    action,
    script === undefined ? NONE : [code(script, 'javascript')],
    failOr(ctx, [...saidText(ctx), ...(shots === 0 ? NONE : [prose(`${String(shots)} 张截图`)])]),
  )
}

const TODO_OPS: Readonly<Record<string, string>> = {
  append: '追加任务',
  block: '标记阻塞',
  done: '完成任务',
  drop: '丢弃任务',
  init: '初始化任务清单',
  rm: '移除任务',
  start: '开始任务',
  unblock: '解除阻塞',
  view: '查看任务清单',
}

const TASK_MARKS: Readonly<Record<string, string>> = {
  abandoned: '（已丢弃）',
  blocked: '（阻塞）',
  completed: '（完成）',
  in_progress: '（进行中）',
  pending: '',
}

// omp 清单分段、四档状态（比协议多一档「丢弃」），自己拼 GFM 任务清单。
function taskLine(task: unknown): string {
  const content = pick(task, 'content') ?? ''
  const status = pick(task, 'status') ?? 'pending'
  const box = status === 'completed' ? '- [x]' : status === 'abandoned' ? '- [~]' : '- [ ]'
  const blocker = status === 'blocked' ? pick(task, 'blocker') : undefined
  const note = blocker === undefined ? (TASK_MARKS[status] ?? '') : `（阻塞：${blocker}）`

  return `${box} ${content}${note}`
}

function checklistOf(phases: readonly unknown[]): string {
  const lines: string[] = []
  const many = phases.length > 1

  for (const entry of phases) {
    const name = pick(entry, 'name')
    const tasks = list(entry, 'tasks')

    if (many && name !== undefined && tasks.length > 0) {
      lines.push(lines.length === 0 ? `**${name}**` : `\n**${name}**`)
    }

    for (const task of tasks) {
      lines.push(taskLine(task))
    }
  }

  return lines.join('\n')
}

// init 给分段的 list，append 给平铺的 items；归一成同一种形后只有一条画法。
function argPhases(input: unknown): readonly unknown[] {
  const items = list(input, 'items')

  if (items.length > 0) {
    return [
      {
        name: pick(input, 'phase') ?? '',
        tasks: items.map((content) => ({ content, status: 'pending' })),
      },
    ]
  }

  return list(input, 'list').map((entry) => ({
    name: pick(entry, 'phase') ?? '',
    tasks: list(entry, 'items').map((content) => ({ content, status: 'pending' })),
  }))
}

const todoView: Handler = (ctx) => {
  const op = pick(ctx.input, 'op') ?? 'view'
  const task = pick(ctx.input, 'task') ?? pick(ctx.input, 'phase') ?? ''
  // 产出的 phases 是落定后的清单（正本）；还没有产出时才照入参画。
  const board = checklistOf(list(ctx.details, 'phases'))
  const drawn = board === '' ? checklistOf(argPhases(ctx.input)) : board
  const landed = board !== ''
  const head = TODO_OPS[op] ?? op

  return view(
    'todo',
    join(head, task) || '更新任务清单',
    task,
    landed ? NONE : drawn === '' ? NONE : [prose(drawn)],
    landed ? (drawn === '' ? NONE : [prose(drawn)]) : failOr(ctx, proseSaid(ctx)),
    landed ? 'result' : 'flow',
  )
}

const askView: Handler = (ctx) => {
  const questions = list(ctx.input, 'questions')
  const first = bag(questions[0])
  const question = pick(first, 'question') ?? ''
  const options = list(first, 'options')
  const body = options
    .map((entry, index) => {
      const label = pick(entry, 'label') ?? ''
      const note = pick(entry, 'description')

      return `${String(index + 1)}. ${label}${note === undefined ? '' : ` —— ${note}`}`
    })
    .join('\n')
  const multiple = questions.length > 1 ? `${String(questions.length)} 个问题` : undefined

  return view(
    'other',
    join('询问', multiple ?? oneLine(question)) || '询问',
    oneLine(question),
    [
      ...(question === '' ? NONE : [prose(`**${question}**`)]),
      ...(body === '' ? NONE : [code(body, 'text')]),
    ],
    failOr(ctx, proseSaid(ctx)),
  )
}

const taskView: Handler = (ctx) => {
  const single = pick(ctx.input, 'task') ?? ''
  const batch = list(ctx.input, 'tasks')
  const named = pick(ctx.input, 'name')
  const agent = pick(ctx.input, 'agent') ?? 'task'
  const descriptions = batch
    .map((entry) => pick(entry, 'description') ?? pick(entry, 'task'))
    .filter((entry): entry is string => entry !== undefined)
  const body =
    batch.length === 0
      ? single
      : batch
          .map((entry, index) => {
            const label = pick(entry, 'name') ?? `#${String(index + 1)}`

            return `## ${label}\n\n${pick(entry, 'task') ?? ''}`
          })
          .join('\n\n')
  const shared = pick(ctx.input, 'context')
  const subject =
    batch.length > 1
      ? `${String(batch.length)} 个子代理`
      : oneLine(descriptions[0] ?? (single === '' ? (named ?? agent) : single))

  return view(
    'delegate',
    join('派发子代理', subject) || '派发子代理',
    subject,
    [
      ...(shared === undefined ? NONE : [prose(`**共同上下文**\n\n${shared}`)]),
      ...(body === '' ? NONE : [prose(body)]),
    ],
    failOr(ctx, proseSaid(ctx)),
  )
}

const yieldView: Handler = (ctx) => {
  const kinds = strings(ctx.input, 'type')
  const error = pick(ctx.input, 'error')
  const data = get(ctx.input, 'data')

  return view(
    'other',
    error === undefined ? '交出结果' : '交出失败',
    kinds.join('、'),
    data === undefined ? NONE : [code(JSON.stringify(data, null, 2) ?? String(data), 'json')],
    failOr(ctx, saidText(ctx)),
  )
}

const thinkView: Handler = (ctx) =>
  view('other', oneLine(pick(ctx.input, 'thoughts') ?? '内心独白'), '', NONE, NONE)

const GOAL_OPS: Readonly<Record<string, string>> = {
  complete: '完成目标',
  create: '立下目标',
  drop: '放弃目标',
  get: '查看目标',
  resume: '继续目标',
}

const goalView: Handler = (ctx) => {
  const op = pick(ctx.input, 'op') ?? 'get'
  const objective = pick(ctx.input, 'objective') ?? ''
  const budget = numb(ctx.input, 'token_budget')
  const head = GOAL_OPS[op] ?? op

  return view(
    'goal',
    join(head, oneLine(objective)) || head,
    oneLine(objective),
    budget === undefined ? NONE : [prose(`预算 ${String(budget)} token`)],
    failOr(ctx, proseSaid(ctx)),
  )
}

const checkpointView: Handler = (ctx) => {
  const goal = pick(ctx.input, 'goal') ?? ''

  return view(
    'other',
    join('设立检查点', oneLine(goal)) || '设立检查点',
    oneLine(goal),
    goal === '' ? NONE : [prose(goal)],
    failOr(ctx, saidText(ctx)),
  )
}

const rewindView: Handler = (ctx) => {
  const report = pick(ctx.input, 'report') ?? ''

  return view(
    'other',
    join('回退到检查点', oneLine(report)) || '回退到检查点',
    oneLine(report),
    report === '' ? NONE : [prose(report)],
    failOr(ctx, saidText(ctx)),
  )
}

const contextNotesView: Handler = (ctx) => {
  const body = get(ctx.input, 'text')

  return body === undefined
    ? view('other', '查看上下文笔记', '', NONE, failOr(ctx, saidText(ctx)), 'result')
    : view(
        'other',
        '更新上下文笔记',
        '',
        [prose(typeof body === 'string' ? body : '')],
        failOr(ctx, saidText(ctx)),
      )
}

const newContextView: Handler = (ctx) =>
  view('other', '开启新上下文', '', NONE, failOr(ctx, saidText(ctx)), 'result')

const waitView: Handler = (ctx) =>
  view('other', '等待后台结果', '', NONE, failOr(ctx, saidText(ctx)), 'result')

/*
 * hub：18.2.11 的协调面入口，12 个 op 三块 —— 对等消息（send / wait / inbox）、后台
 * 作业（list / jobs / cancel / ps）、受管进程（start / logs / stop / restart / describe）。
 *
 * 我们现在钉 18.3.0，它把这一格收成了 `wait`（空 schema，只等下一个后台结果或同伴消息），
 * 所以新会话不再报 hub。留着它是因为**磁盘上有 18.2.11 写下的会话**：重开一段旧对话时那
 * 些调用要从 jsonl 回放出来，没有这一档它们就是裸 JSON。
 *
 * 每一档自己说自己在做什么：一个 `hub` 后面可以是「给某个 agent 发消息」也可以是「起一个
 * 长驻进程来看日志」，只报工具名等于什么都没说。
 */
const HUB_OPS: Readonly<Record<string, string>> = {
  cancel: '终止作业',
  describe: '查看进程',
  inbox: '收取消息',
  jobs: '查看作业',
  list: '查看同伴',
  logs: '读进程日志',
  ps: '查看进程表',
  restart: '重启进程',
  send: '发送消息',
  start: '启动进程',
  stop: '停止进程',
  wait: '等待消息',
}

const hubView: Handler = (ctx) => {
  const op = pick(ctx.input, 'op') ?? ''
  const said = HUB_OPS[op] ?? '协调'
  /* 主语按 op 换：发消息看收件人，起进程看名字，等消息看来源。 */
  const to = pick(ctx.input, 'to')
  const name = pick(ctx.input, 'name')
  const from = pick(ctx.input, 'from')
  const application = pick(ctx.input, 'application')
  const subject = to ?? name ?? from ?? application ?? ''

  return view(
    'delegate',
    join(said, subject) || said,
    subject || said,
    [prose(join(said, subject === '' ? undefined : at(subject)))],
    failOr(ctx, saidText(ctx)),
    'result',
  )
}

const searchView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''
  const recency = pick(ctx.input, 'recency')
  const sources = list(get(ctx.details, 'response'), 'sources').length

  return view(
    'fetch',
    `联网搜索 ${query}`,
    query,
    [prose(join(`搜索 ${at(query)}`, recency === undefined ? undefined : `时限 ${recency}`))],
    failOr(ctx, [
      ...proseSaid(ctx),
      ...(sources === 0 ? NONE : [prose(`${String(sources)} 条来源`)]),
    ]),
    'result',
  )
}

const GITHUB_OPS: Readonly<Record<string, string>> = {
  file_read: '读取仓库文件',
  pr_checkout: '检出 PR',
  pr_create: '创建 PR',
  pr_push: '推送分支',
  repo_view: '查看仓库',
  run_watch: '监视工作流',
  search_code: '搜索代码',
  search_commits: '搜索提交',
  search_issues: '搜索议题',
  search_prs: '搜索 PR',
  search_repos: '搜索仓库',
}

const githubView: Handler = (ctx) => {
  const op = pick(ctx.input, 'op') ?? ''
  const head = GITHUB_OPS[op] ?? op
  const subject = dot(
    pick(ctx.input, 'repo') ?? pick(ctx.details, 'repo'),
    pick(ctx.input, 'path'),
    strings(ctx.input, 'pr').join('、'),
    pick(ctx.input, 'branch'),
    pick(ctx.input, 'query'),
    pick(ctx.input, 'title'),
    pick(ctx.input, 'run'),
  )

  return view(
    'fetch',
    join(`GitHub ${head}`, subject) || `GitHub ${head}`,
    subject,
    NONE,
    failOr(ctx, proseSaid(ctx)),
    'result',
  )
}

const debugView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const head = action.replaceAll('_', ' ')
  const subject = dot(
    pick(ctx.input, 'program'),
    pick(ctx.input, 'file'),
    pick(ctx.input, 'function'),
    pick(ctx.input, 'name'),
  )
  const expression = pick(ctx.input, 'expression')

  return view(
    'other',
    join(`调试 ${head}`, subject) || `调试 ${head}`,
    subject,
    [
      ...(expression === undefined ? NONE : [code(expression, 'text')]),
      ...(subject === '' ? NONE : [prose(subject)]),
    ],
    failOr(ctx, saidText(ctx)),
  )
}

const securityScanView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const head = action.replaceAll('_', ' ')
  const subject =
    pick(ctx.input, 'target_kind') ?? pick(ctx.input, 'plan_id') ?? pick(ctx.input, 'scan_id') ?? ''

  return view(
    'other',
    join('安全扫描', dot(head, subject)) || '安全扫描',
    subject,
    NONE,
    failOr(ctx, saidText(ctx)),
    'result',
  )
}

const MEMORY_EDITS: Readonly<Record<string, string>> = {
  forget: '遗忘记忆',
  invalidate: '作废记忆',
  update: '修订记忆',
}

const memoryEditView: Handler = (ctx) => {
  const op = pick(ctx.input, 'op') ?? ''
  const id = pick(ctx.input, 'id') ?? ''
  const head = MEMORY_EDITS[op] ?? op

  return view('other', join(head, id) || head, id, NONE, failOr(ctx, saidText(ctx)), 'result')
}

const retainView: Handler = (ctx) => {
  const body = list(ctx.input, 'items')
    .map((entry) => pick(entry, 'content'))
    .filter((entry): entry is string => entry !== undefined)

  return view(
    'other',
    `记住 ${String(body.length)} 条`,
    `${String(body.length)} 条`,
    body.length === 0 ? NONE : [prose(body.map((one) => `- ${one}`).join('\n'))],
    failOr(ctx, saidText(ctx)),
  )
}

const recallView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''

  return view('search', `回忆 ${query}`, query, NONE, failOr(ctx, proseSaid(ctx)), 'result')
}

const reflectView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''

  return view('other', `反思 ${query}`, query, NONE, failOr(ctx, proseSaid(ctx)), 'result')
}

const learnView: Handler = (ctx) => {
  const memory = pick(ctx.input, 'memory') ?? ''
  const skill = get(ctx.input, 'skill')
  const name = pick(skill, 'name')

  return view(
    'skill',
    join('习得经验', oneLine(memory)) || '习得经验',
    oneLine(memory),
    [
      prose(memory),
      ...(name === undefined
        ? NONE
        : [prose(`同时${pick(skill, 'action') === 'update' ? '更新' : '新建'}技能 ${at(name)}`)]),
    ],
    failOr(ctx, saidText(ctx)),
  )
}

const MANAGE_SKILLS: Readonly<Record<string, string>> = {
  create: '新建技能',
  delete: '删除技能',
  update: '更新技能',
}

const manageSkillView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const name = pick(ctx.input, 'name') ?? ''
  const head = MANAGE_SKILLS[action] ?? action
  const description = pick(ctx.input, 'description')
  const body = pick(ctx.input, 'body')

  return view(
    'skill',
    join(head, name) || head,
    name,
    [
      ...(description === undefined ? NONE : [prose(description)]),
      ...(body === undefined ? NONE : [prose(body)]),
    ],
    failOr(ctx, saidText(ctx)),
  )
}

const imageGenView: Handler = (ctx) => {
  const subject = pick(ctx.input, 'subject') ?? ''
  const changes = strings(ctx.input, 'changes')

  return view(
    'other',
    join('生成图片', oneLine(subject)) || '生成图片',
    oneLine(subject),
    changes.length === 0 ? NONE : [prose(changes.map((one) => `- ${one}`).join('\n'))],
    failOr(ctx, saidText(ctx)),
  )
}

const ttsView: Handler = (ctx) => {
  const said = pick(ctx.input, 'text') ?? ''
  const path = pick(ctx.input, 'output_path') ?? ''

  return view(
    'other',
    join('合成语音', oneLine(said)) || '合成语音',
    oneLine(said),
    [prose(said), ...(path === '' ? NONE : [prose(`写到 ${at(path)}`)])],
    failOr(ctx, saidText(ctx)),
  )
}

const vibeSpawnView: Handler = (ctx) => {
  const cli = pick(ctx.input, 'cli') ?? ''
  const prompt = pick(ctx.input, 'prompt') ?? ''

  return view(
    'delegate',
    `启动 vibe 会话（${cli}）`,
    cli,
    [prose(prompt)],
    failOr(ctx, proseSaid(ctx)),
  )
}

const vibeSendView: Handler = (ctx) => {
  const session = pick(ctx.input, 'session') ?? ''

  return view(
    'delegate',
    `发给 vibe 会话 ${session}`,
    session,
    [prose(pick(ctx.input, 'message') ?? '')],
    failOr(ctx, proseSaid(ctx)),
  )
}

const vibeWaitView: Handler = (ctx) => {
  const sessions = strings(ctx.input, 'sessions')
  const subject = sessions.length === 0 ? '全部在跑的会话' : sessions.join('、')

  return view(
    'delegate',
    `等待 vibe 会话 ${subject}`,
    subject,
    NONE,
    failOr(ctx, proseSaid(ctx)),
    'result',
  )
}

const vibeKillView: Handler = (ctx) => {
  const session = pick(ctx.input, 'session') ?? ''

  return view(
    'delegate',
    `终止 vibe 会话 ${session}`,
    session,
    NONE,
    failOr(ctx, proseSaid(ctx)),
    'result',
  )
}

const vibeListView: Handler = (ctx) =>
  view('delegate', '查看 vibe 会话', '', NONE, failOr(ctx, proseSaid(ctx)), 'result')

/*
 * xd:// 设备：不是顶层工具，只能经 `write xd://<name>` 到达（omp 的 tools/xdev.ts）。
 * writeView 按 details.xdev.tool 委派，所以这几个名字要认得 —— 委派到一个没有处理器的
 * 名字上，屏幕上就只剩裸名字。
 */
const deviceView = (said: string): Handler =>
  function device(ctx) {
    return view('other', said, '', NONE, failOr(ctx, proseSaid(ctx)), 'result')
  }

// MCP 名字里没有可靠的分隔保证，只认前缀，剩下的原样报出来——猜错拆位比不拆更糟。
function mcpView(name: string, input: unknown): OmpToolView {
  const rest = name.slice(5)
  const cut = rest.search(/__?/)
  const server = cut <= 0 ? rest : rest.slice(0, cut)
  const tool = cut <= 0 ? '' : rest.slice(cut).replace(/^_+/, '')
  const subject = tool === '' ? server : `${server} · ${tool}`
  const guess = describeTool(input)

  return {
    known: true,
    kind: guess.kind,
    headline: subject,
    subject: subject === '' ? guess.subject : subject,
    shape: 'result',
    background: false,
    request: NONE,
    response: NONE,
  }
}

/*
 * 表里每一个名字都是 omp 真的会报出来的那一个。
 *
 * - 内建与隐藏工具：tools/builtin-names.ts 的 BUILTIN_TOOL_NAMES + HIDDEN_TOOL_NAMES。
 * - search 是它自己的历史别名（同文件的 LEGACY_BUILTIN_TOOL_NAME_ALIASES → grep）。
 * - apply_patch / puppeteer / js / python / notebook：官方视图表里登记的别名
 *   （dist/tool-views.generated-*.js 的注册表），老会话里存着的名字要认得。
 * - browser / computer：eval 的 prelude（不是顶层工具，见 evalView），但官方视图表按
 *   工具名登记它们，所以这里也留一档。
 * - generate_image / tts / vibe_*：omp 注册的 CustomTool，同样以工具呼叫做出来。
 * - report_issue / resolve / reject / propose：xd:// 设备，经 write 委派到达。
 */
const HANDLERS: Readonly<Record<string, Handler>> = {
  apply_patch: editView,
  ask: askView,
  ast_edit: astEditView,
  ast_grep: astGrepView,
  bash: bashView,
  browser: browserView,
  checkpoint: checkpointView,
  computer: computerView,
  context_notes: contextNotesView,
  debug: debugView,
  edit: editView,
  eval: evalView,
  fetch: readView,
  find: findView,
  generate_image: imageGenView,
  github: githubView,
  glob: globView,
  goal: goalView,
  grep: grepView,
  hub: hubView,
  js: evalAlias('js'),
  learn: learnView,
  lsp: lspView,
  manage_skill: manageSkillView,
  memory_edit: memoryEditView,
  new_context: newContextView,
  notebook: evalAlias('js'),
  propose: deviceView('提交提案'),
  puppeteer: browserView,
  python: evalAlias('py'),
  read: readView,
  recall: recallView,
  reflect: reflectView,
  reject: deviceView('驳回待决事项'),
  report_issue: deviceView('报告工具问题'),
  report_tool_issue: deviceView('报告工具问题'),
  resolve: deviceView('处理待决事项'),
  retain: retainView,
  rewind: rewindView,
  search: grepView,
  security_scan: securityScanView,
  task: taskView,
  think: thinkView,
  todo: todoView,
  tts: ttsView,
  vibe_kill: vibeKillView,
  vibe_list: vibeListView,
  vibe_send: vibeSendView,
  vibe_spawn: vibeSpawnView,
  vibe_wait: vibeWaitView,
  wait: waitView,
  web_search: searchView,
  write: writeView,
  yield: yieldView,
}

const EMPTY: OmpToolView = {
  known: false,
  kind: 'other',
  headline: '',
  subject: '',
  shape: 'tabs',
  background: false,
  request: NONE,
  response: NONE,
}

/*
 * 那一行字认谁。
 *
 * omp 自己带一句 intent（提示里叫 "concise intent"，由模型写：「Reading ADR 0052」
 * 「Checking kap-client drift」），比我们按参数猜得准，所以默认用它。但有两档要压过它
 * —— 与 omp 官方那条路（modes/acp 的 buildToolTitle）同一条优先级：
 *
 * 1. 命令与脚本：`bash` 那一行本来就该是命令本身，模型的概括词盖不过它。
 * 2. 没写 intent 的老会话：退回按参数算出来的那一句。
 *
 * 其余工具（读文件、搜索、派发、清单…）一律听 intent：那是这个 agent 说它自己在做什么，
 * 我们按路径或模式拼出来的那句话只是它的近似。
 */
const INTENT_OVERRIDDEN: ReadonlySet<string> = new Set(['bash', 'eval', 'js', 'python', 'notebook'])

/** 这次调用最终印在折叠行上的那一句话。 */
function headlineOf(name: string, derived: string, intent: string | undefined): string {
  if (intent === undefined || intent === '') {
    return derived
  }

  return INTENT_OVERRIDDEN.has(name.toLowerCase()) && derived !== '' ? derived : intent
}

export function ompToolView(
  name: string,
  input: unknown,
  output: unknown,
  error?: string,
  intent?: string,
): OmpToolView {
  const handler = HANDLERS[name.toLowerCase()]
  const base =
    handler === undefined
      ? name.startsWith('mcp__')
        ? mcpView(name, input)
        : EMPTY
      : handler({ details: detailsOf(output), error, input, output, said: textOf(output) })

  if (!base.known) {
    return EMPTY
  }

  const shots = imagesOf(output)
  // background 由产出自己说（details.async），与处理器无关，在这里统一补。
  const background = bag(get(detailsOf(output), 'async')) !== undefined

  return {
    ...base,
    background,
    headline: headlineOf(name, base.headline, intent),
    ...(shots.length === 0 ? {} : { response: [...base.response, ...shots] }),
  }
}
