import type { ToolCallContent } from '../../../agent/tool-call'
import type { Ctx, Handler } from '../view-kit'
import {
  at,
  bag,
  blocksOf,
  code,
  failOr,
  flag,
  get,
  join,
  langOf,
  list,
  NONE,
  numb,
  oneLine,
  pick,
  prose,
  saidText,
  strings,
  view,
  viewOf,
} from '../view-kit'

// 非零退出码与超时不在折叠行上报，落在产出那面。
export const bashView: Handler = (ctx) => {
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

/*
 * read 是传输工具，读的是什么由地址说：记忆、技能各有自己的动词，网页是「抓取」而且归 fetch 类；其余地址照旧「阅读」。
 * 动词与 omp-tool-glyphs 的字形、tool-family 的分族同一批判据，三处说的是同一件事。
 */
const READ_HEADS: Readonly<Record<string, string>> = {
  memory: '读取记忆',
  skill: '读取技能',
}

function addressOf(path: string): { readonly scheme: string; readonly rest: string } {
  const cut = path.indexOf('://')

  return cut <= 0 ? { scheme: '', rest: path } : { scheme: path.slice(0, cut).toLowerCase(), rest: path.slice(cut + 3) }
}

function readHeadOf(path: string, isFetch: boolean): { readonly kind: 'fetch' | 'read'; readonly head: string } {
  if (path === '') {
    return isFetch ? { kind: 'fetch', head: '抓取网页' } : { kind: 'read', head: '读取文件' }
  }

  const { rest, scheme } = addressOf(path)

  if (isFetch || scheme === 'http' || scheme === 'https') {
    return { kind: 'fetch', head: `抓取 ${path}` }
  }

  const verb = READ_HEADS[scheme]

  return verb === undefined || rest === ''
    ? { kind: 'read', head: `阅读 ${path}` }
    : { kind: 'read', head: `${verb} ${rest}` }
}

// 给人看的原始正文在 details.displayContent.text（hashline 模式下入参带行号前缀）。
function readWith(isFetch: boolean): Handler {
  return (ctx) => {
    const path = pick(ctx.input, 'path') ?? pick(ctx.input, 'url') ?? pick(ctx.details, 'resolvedPath') ?? ''
    const shown = pick(get(ctx.details, 'displayContent'), 'text') ?? ctx.said
    const conflict = numb(ctx.details, 'conflictCount')
    const { head, kind } = readHeadOf(path, isFetch)

    return view(
      kind,
      head,
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
}

export const readView: Handler = readWith(false)

// fetch 是「读 URL」那一把：画法与 read 相同，类别与动词归网页。
export const fetchView: Handler = readWith(true)

// write 还是 xd:// 传输本身：omp 把可挂载工具收进 write xd://<tool>，
// 一次 write 其实是在调另一个工具，按被调的那个工具画，否则永远显示成「写入 xd://browser」。
export const writeView: Handler = (ctx) => {
  const path = pick(ctx.input, 'path') ?? pick(ctx.details, 'resolvedPath') ?? ''
  const device = bag(get(ctx.details, 'xdev'))
  const tool = pick(device, 'tool')

  // read/write 是传输本身，不会是被挂载的设备。
  if (tool !== undefined && tool !== 'read' && tool !== 'write' && pick(device, 'mode') !== 'help') {
    const inner = get(device, 'inner')
    const args = get(device, 'args')
    const invoked = viewOf(tool, args, { content: blocksOf(ctx.output), details: inner })

    /* 名字要跟着被调的工具走：字形按名字取，认 write 会画成铅笔而屏幕上写着「读取诊断」。 */
    return {
      ...invoked,
      invokedTool: tool,
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
export function editDiffs(ctx: Ctx): readonly ToolCallContent[] {
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
  const newText = pick(held, 'newText') ?? pick(ctx.input, 'newText') ?? pick(ctx.input, 'new_string')

  if (path === undefined || newText === undefined) {
    return NONE
  }

  const oldText = pick(held, 'oldText') ?? pick(ctx.input, 'oldText') ?? pick(ctx.input, 'old_string')

  return [{ type: 'diff' as const, path, ...(oldText === undefined ? {} : { oldText }), newText }]
}

// 交不出新旧正文时：先退回产出自己算好的统一 diff，再是入参补丁正文。
export function editPatch(ctx: Ctx): readonly ToolCallContent[] {
  const diff = pick(ctx.details, 'diff')
  const patch = pick(ctx.input, 'input')

  if (diff !== undefined) {
    return [code(diff, 'diff')]
  }

  return patch === undefined ? NONE : [code(patch, 'diff')]
}

export const EDIT_HEADS: Readonly<Record<string, string>> = {
  create: '新建',
  delete: '删除',
  update: '编辑',
}

export function editOp(ctx: Ctx): string | undefined {
  const top = pick(ctx.details, 'op')

  if (top !== undefined) {
    return top
  }

  const many = get(ctx.details, 'perFileResults')

  return Array.isArray(many) ? pick(many[0], 'op') : undefined
}

export const editView: Handler = (ctx) => {
  const path = pick(ctx.input, 'path') ?? pick(ctx.details, 'path') ?? pick(ctx.details, 'resolvedPath') ?? ''
  const diffs = editDiffs(ctx)
  const patch = editPatch(ctx)
  const request = diffs.length > 0 ? diffs : patch.length > 0 ? patch : path === '' ? NONE : [prose(`编辑 ${at(path)}`)]
  const head = join(EDIT_HEADS[editOp(ctx) ?? ''] ?? '编辑', path === '' ? undefined : path)
  const moved = pick(ctx.details, 'move')

  return view(
    'edit',
    head === '' ? '编辑文件' : head,
    path,
    request,
    failOr(ctx, [...(moved === undefined ? NONE : [prose(`重命名为 ${at(moved)}`)]), ...saidText(ctx)]),
    'diff',
  )
}

export const astEditView: Handler = (ctx) => {
  const where = strings(ctx.input, 'paths').join('、')
  const ops = list(ctx.input, 'ops')
  const pats = ops.map((entry) => pick(entry, 'pat')).filter((entry): entry is string => entry !== undefined)
  const request =
    pats.length === 0 ? NONE : [code(pats.map((pat, index) => `${String(index + 1)}. ${pat}`).join('\n'), 'text')]
  const subject = where === '' ? `${String(ops.length)} 处` : where

  return view('edit', `AST 改写 ${subject}`, subject, request, failOr(ctx, saidText(ctx)))
}
