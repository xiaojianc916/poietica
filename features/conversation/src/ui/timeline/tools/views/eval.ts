import type { Ctx, Handler, OmpToolView } from '../view-kit'
import { code, dot, failOr, get, join, list, NONE, oneLine, pick, prose, saidText, view } from '../view-kit'

export const EVAL_LANGS: Readonly<Record<string, string>> = { js: 'javascript', py: 'python' }

/*
 * `browser`/`computer` 是注入 eval 内核的 prelude 作用域对象，不是顶层工具；模型写 `browser.open(...)` 等调用，每次都在产出里留一条 details.statusEvents。
 * 单独挑出来说 —— 一次浏览器动作不该显示成「运行 JavaScript」。
 */
export const PRELUDE_NAMES: Readonly<Record<string, string>> = {
  browser: '浏览器',
  computer: '桌面控制',
}

/** 这次 eval 调过的 prelude 名（原始 op，不是给人看的那句）。 */
export function preludeOpsOf(ctx: Ctx): readonly string[] {
  const ops: string[] = []
  /* 事件既可能挂在整次调用上，也可能挂在产生它的那个 cell 上。 */
  const events = [...list(ctx.details, 'statusEvents')]

  for (const cell of list(ctx.details, 'cells')) {
    events.push(...list(cell, 'statusEvents'))
  }

  for (const event of events) {
    const op = pick(event, 'op')

    if (op !== undefined && PRELUDE_NAMES[op] !== undefined && !ops.includes(op)) {
      ops.push(op)
    }
  }

  return ops
}

/** 这次 eval 调了哪些 prelude，各做了什么。 */
export function preludesOf(ctx: Ctx): readonly string[] {
  const said: string[] = []
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

/*
 * 状态事件到达前先按代码预判：否则卡片会在运行中途从「运行 JavaScript」跳成浏览器卡片。判据只认真正的调用形状（`browser.open(` 这一串），不认「提到过」——误判一次就是把脚本运行说成浏览器动作。
 * 同时写着 computer 时不预判：那是两件事，认错比晚认更糟。
 */
export const BROWSER_CALL = /\bbrowser\s*\.\s*(?:open|tab|tabs|close)\s*\(/u
export const COMPUTER_CALL = /\bcomputer\s*\./u

export function guessedPreludeOf(code: string): string | null {
  return BROWSER_CALL.test(code) && !COMPUTER_CALL.test(code) ? 'browser' : null
}

export const evalView: Handler = (ctx) => evalCall(ctx, pick(ctx.input, 'language') ?? 'js')

/* 官方视图表把 js/python/notebook 指到同一渲染器，入参没 language 时按别名来，而非一律落回 JavaScript。 */
export const evalAlias =
  (language: string): Handler =>
  (ctx) =>
    evalCall(ctx, pick(ctx.input, 'language') ?? language)

export function evalCall(ctx: Ctx, language: string): OmpToolView {
  const named = language === 'py' ? 'Python' : 'JavaScript'
  const body = pick(ctx.input, 'code') ?? ''
  const title = pick(ctx.input, 'title')
  const cells = list(ctx.details, 'cells')
  // 后端自己的 cells 才是真正跑过的那几段。
  const request =
    cells.length === 0
      ? [code(body, EVAL_LANGS[language] ?? '')]
      : cells.map((entry) => code(pick(entry, 'code') ?? '', EVAL_LANGS[language] ?? ''))
  /* 调了 prelude 就报那件事，否则退回「运行 JavaScript」：两者都报会把一次浏览器动作说成脚本运行。 */
  const preludes = preludesOf(ctx)
  const head = preludes.length > 0 ? preludes.join('；') : dot(`运行 ${named}`, title ?? oneLine(body))
  /*
   * 字形也跟着那件事走：一次 browser.open 实际跑的是浏览器，不是脚本。用 invokedTool 这一格 —— 它就是「真正在跑的是谁」。
   * 还没有状态事件时按代码预判一次，否则这一行会在运行中途换一张卡片。
   */
  const ops = preludeOpsOf(ctx)
  const running = ops.length === 1 ? (ops[0] as string) : ops.length === 0 ? guessedPreludeOf(body) : null

  return {
    ...view('execute', head, preludes[0] ?? title ?? oneLine(body), request, failOr(ctx, saidText(ctx))),
    ...(running === null ? {} : { invokedTool: running }),
  }
}

export const BROWSER_ACTIONS: Readonly<Record<string, string>> = {
  call: '调用标签页',
  close: '关闭标签页',
  open: '打开',
  run: '执行脚本',
  tabs: '列出标签页',
}

export const browserView: Handler = (ctx) => {
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

export const COMPUTER_ACTIONS: Readonly<Record<string, string>> = {
  call: '调用桌面接口',
  capabilities: '查看能力',
  close: '关闭会话',
  run: '执行脚本',
}

export const computerView: Handler = (ctx) => {
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
