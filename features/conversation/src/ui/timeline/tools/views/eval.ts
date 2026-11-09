import type { Ctx, Handler, OmpToolView } from '../view-kit'
import { code, dot, failOr, given, join, NONE, oneLine, prose, saidText, view } from '../view-kit'

export const EVAL_LANGS: Readonly<Record<string, string>> = { js: 'javascript', py: 'python' }

type EvalCtx = Ctx<'eval' | 'js' | 'python' | 'notebook'>

/*
 * `browser`/`computer` 是注入 eval 内核的 prelude 作用域对象，不是顶层工具；模型写 `browser.open(...)` 等调用，每次都在产出里留一条 details.statusEvents。
 * 单独挑出来说 —— 一次浏览器动作不该显示成「运行 JavaScript」。
 */
export const PRELUDE_NAMES: Readonly<Record<string, string>> = {
  browser: '浏览器',
  computer: '桌面控制',
}

/** 这次 eval 调过的 prelude 名（原始 op，不是给人看的那句）。 */
export function preludeOpsOf(ctx: EvalCtx): readonly string[] {
  /* 去重与成员判断共用一份 Set；最后才摊回数组，保留事件出现次序。 */
  const ops = new Set<string>()
  /* 事件既可能挂在整次调用上，也可能挂在产生它的那个 cell 上。 */
  const events = [
    ...(ctx.details?.statusEvents ?? []),
    ...(ctx.details?.cells ?? []).flatMap((cell) => cell.statusEvents ?? []),
  ]

  for (const event of events) {
    if (PRELUDE_NAMES[event.op] !== undefined) {
      ops.add(event.op)
    }
  }

  return [...ops]
}

/** 这次 eval 调了哪些 prelude，各做了什么。 */
export function preludesOf(ctx: EvalCtx): readonly string[] {
  const said: string[] = []
  const events = [
    ...(ctx.details?.statusEvents ?? []),
    ...(ctx.details?.cells ?? []).flatMap((cell) => cell.statusEvents ?? []),
  ]

  for (const event of events) {
    const label = PRELUDE_NAMES[event.op]

    if (label === undefined) {
      continue
    }

    /* statusEvents 的额外格子没有逐格声明（omp 的索引签名），只认给人看的那一串字符。 */
    const detail = typeof event.detail === 'string' && event.detail !== '' ? event.detail : undefined

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

export const evalView: Handler<'eval'> = (ctx) => evalCall(ctx, given(ctx.input?.language) ?? 'js')

/* 官方视图表把 js/python/notebook 指到同一渲染器，入参没 language 时按别名来，而非一律落回 JavaScript。 */
export const evalAlias =
  (language: string): Handler<'eval' | 'js' | 'python' | 'notebook'> =>
  (ctx) =>
    evalCall(ctx, given(ctx.input?.language) ?? language)

export function evalCall(ctx: EvalCtx, language: string): OmpToolView {
  const named = language === 'py' ? 'Python' : 'JavaScript'
  const body = ctx.input?.code ?? ''
  const title = given(ctx.input?.title)
  const cells = ctx.details?.cells ?? []
  // 后端自己的 cells 才是真正跑过的那几段。
  const request =
    cells.length === 0
      ? [code(body, EVAL_LANGS[language] ?? '')]
      : cells.map((entry) => code(entry.code, EVAL_LANGS[language] ?? ''))
  /* 调了 prelude 就报那件事，否则退回「运行 JavaScript」：两者都报会把一次浏览器动作说成脚本运行。 */
  const preludes = preludesOf(ctx)
  const head = preludes.length > 0 ? preludes.join('；') : dot(`运行 ${named}`, title ?? oneLine(body))
  /*
   * 字形也跟着那件事走：一次 browser.open 实际跑的是浏览器，不是脚本。用 invokedTool 这一格 —— 它就是「真正在跑的是谁」。
   * 还没有状态事件时按代码预判一次，否则这一行会在运行中途换一张卡片。
   */
  const ops = preludeOpsOf(ctx)
  const running = ops.length === 1 ? (ops[0] ?? null) : ops.length === 0 ? guessedPreludeOf(body) : null

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

export const browserView: Handler<'browser' | 'puppeteer'> = (ctx) => {
  const action = ctx.input?.action ?? ''
  const name = given(ctx.input?.name) ?? 'main'
  const url = given(ctx.input?.url) ?? given(ctx.details?.url)
  const chain = ctx.input?.chain
  const script =
    given(ctx.input?.code) ?? given(ctx.input?.fn) ?? (chain === undefined ? undefined : JSON.stringify(chain, null, 2))
  const shots = ctx.details?.screenshots?.length ?? 0
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

export const computerView: Handler<'computer'> = (ctx) => {
  const action = ctx.input?.action ?? ''
  const chain = ctx.input?.chain
  const script =
    given(ctx.input?.code) ?? given(ctx.input?.fn) ?? (chain === undefined ? undefined : JSON.stringify(chain, null, 2))
  const shots = ctx.details?.screenshots?.length ?? 0
  const head = COMPUTER_ACTIONS[action] ?? action

  return view(
    'execute',
    `桌面控制 · ${head}`,
    action,
    script === undefined ? NONE : [code(script, 'javascript')],
    failOr(ctx, [...saidText(ctx), ...(shots === 0 ? NONE : [prose(`${String(shots)} 张截图`)])]),
  )
}
