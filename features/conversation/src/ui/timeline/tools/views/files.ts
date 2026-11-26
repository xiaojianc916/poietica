import type { ToolCallContent } from '@poietica/conversation-kit/model'
import type { OmpGenericToolDetails, OmpToolInputOf } from '@poietica/omp-types'
import type { Ctx, Handler } from '../view-kit'
import {
  at,
  code,
  failOr,
  given,
  join,
  langOf,
  NONE,
  oneLine,
  outputBlocks,
  prose,
  saidText,
  view,
  viewOf,
} from '../view-kit'

// 非零退出码与超时不在折叠行上报，落在产出那面。
export const bashView: Handler<'bash'> = (ctx) => {
  const command = ctx.input?.command ?? ''
  const exit = ctx.details?.exitCode
  const foot =
    ctx.details?.timedOut === true
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

/** 不是内部 URL（http、盘符路径）就是空串。 */
function schemeFrom(value: string | undefined): string {
  if (value === undefined) {
    return ''
  }

  const cut = value.indexOf('://')

  return cut <= 0 ? '' : value.slice(0, cut).toLowerCase()
}

/*
 * 内部地址的 scheme：omp 自己盖的章（details.meta.source.type === 'internal'）优先 —— 它是跑完之后的事实；
 * 调用还在飞的时候没有产出，退回入参 path 上的 scheme。
 */
function schemeOf(
  details: { readonly meta?: { readonly source?: { readonly type: string; readonly value: string } } } | undefined,
  path: string | undefined,
): string {
  const source = details?.meta?.source

  return schemeFrom(source?.type === 'internal' ? source.value : path)
}

// 给人看的原始正文在 details.displayContent.text（hashline 模式下入参带行号前缀）。
export const readView: Handler<'read'> = (ctx) => {
  const path = given(ctx.input?.path) ?? given(ctx.details?.resolvedPath) ?? ''
  const shown = ctx.details?.displayContent?.text ?? ctx.said
  const conflict = ctx.details?.conflictCount
  const { head, kind } = readHeadOf(path, false)

  return {
    ...view(
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
    ),
    scheme: schemeOf(ctx.details, path),
  }
}

// fetch 是「读 URL」那一把：画法与 read 相同，类别与动词归网页。产出细节是 ReadUrlToolDetails，没有 displayContent。
export const fetchView: Handler<'fetch'> = (ctx) => {
  const path = given(ctx.input?.path) ?? given(ctx.input?.url) ?? ''
  const { head, kind } = readHeadOf(path, true)

  return view(
    kind,
    head,
    path,
    NONE,
    failOr(ctx, ctx.said === undefined ? NONE : [code(ctx.said, langOf(path))]),
    'result',
  )
}

/*
 * omp 19 起 `write` 只写文件：`xd://` 设备传输被工具命令取代（少用工具在 bash 里以命令形式跑），
 * 产出 details 里不再有 `xdev`。旧会话里仍留着那一份，按它画回被调的那个工具。
 */
interface LegacyXdev {
  readonly tool: string
  readonly args: OmpToolInputOf | undefined
  readonly mode: string
  readonly inner?: unknown
}

function legacyXdevOf(details: unknown): LegacyXdev | undefined {
  const xdev = (details as { readonly xdev?: unknown } | undefined)?.xdev
  if (typeof xdev !== 'object' || xdev === null) return undefined
  const candidate = xdev as Partial<LegacyXdev>
  return typeof candidate.tool === 'string' && typeof candidate.mode === 'string'
    ? (candidate as LegacyXdev)
    : undefined
}

export const writeView: Handler<'write'> = (ctx) => {
  const path = given(ctx.input?.path) ?? given(ctx.details?.resolvedPath) ?? ''
  const device = legacyXdevOf(ctx.details)

  // read/write 是传输本身，不会是被挂载的设备。
  if (device !== undefined && device.tool !== 'read' && device.tool !== 'write' && device.mode !== 'help') {
    /* 设备的内层产出是原样透传的那一份，类型由被调工具的 schema 保证。 */
    const inner = device.inner as OmpGenericToolDetails | undefined
    const invoked = viewOf(device.tool, device.args, {
      content: outputBlocks(ctx.output),
      ...(inner === undefined ? {} : { details: inner }),
    })

    /* 名字要跟着被调的工具走：字形按名字取，认 write 会画成铅笔而屏幕上写着「读取诊断」。 */
    return {
      ...invoked,
      invokedTool: device.tool,
      headline: invoked.headline === '' ? `xd://${device.tool}` : `xd://${device.tool} · ${invoked.headline}`,
      subject: invoked.subject === '' ? device.tool : invoked.subject,
    }
  }

  const body = given(ctx.input?.content)
  const head = ctx.details?.madeExecutable === true ? '写入并标记可执行' : '写入'

  return {
    ...view(
      'write',
      join(head, path) || head,
      path,
      body === undefined ? NONE : [code(body, langOf(path))],
      failOr(ctx, saidText(ctx)),
    ),
    scheme: schemeOf(ctx.details, path),
  }
}

type EditCtx = Ctx<'edit' | 'apply_patch'>

// hashline 模式下入参只有一段补丁正文，真正的结构在产出 details 里（source of truth）。
function editDiffs(ctx: EditCtx): readonly ToolCallContent[] {
  const held = ctx.details
  const many = held?.perFileResults

  if (many !== undefined) {
    return many.flatMap((entry) =>
      entry.newText === undefined
        ? NONE
        : [
            {
              type: 'diff' as const,
              path: entry.path,
              ...(entry.oldText === undefined ? {} : { oldText: entry.oldText }),
              newText: entry.newText,
            },
          ],
    )
  }

  const path = given(held?.path) ?? given(ctx.input?.path)
  const newText = given(held?.newText) ?? given(ctx.input?.newText) ?? given(ctx.input?.new_string)

  if (path === undefined || newText === undefined) {
    return NONE
  }

  const oldText = given(held?.oldText) ?? given(ctx.input?.oldText) ?? given(ctx.input?.old_string)

  return [{ type: 'diff' as const, path, ...(oldText === undefined ? {} : { oldText }), newText }]
}

// 交不出新旧正文时：先退回产出自己算好的统一 diff，再是入参补丁正文。
function editPatch(ctx: EditCtx): readonly ToolCallContent[] {
  const diff = given(ctx.details?.diff)
  const patch = given(ctx.input?.input)

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

function editOp(ctx: EditCtx): string | undefined {
  const top = ctx.details?.op

  if (top !== undefined) {
    return top
  }

  return ctx.details?.perFileResults?.[0]?.op
}

export const editView: Handler<'edit' | 'apply_patch'> = (ctx) => {
  const path = given(ctx.input?.path) ?? given(ctx.details?.path) ?? ''
  const diffs = editDiffs(ctx)
  const patch = editPatch(ctx)
  const request = diffs.length > 0 ? diffs : patch.length > 0 ? patch : path === '' ? NONE : [prose(`编辑 ${at(path)}`)]
  const head = join(EDIT_HEADS[editOp(ctx) ?? ''] ?? '编辑', path === '' ? undefined : path)
  const moved = given(ctx.details?.move)

  return view(
    'edit',
    head === '' ? '编辑文件' : head,
    path,
    request,
    failOr(ctx, [...(moved === undefined ? NONE : [prose(`重命名为 ${at(moved)}`)]), ...saidText(ctx)]),
    'diff',
  )
}

export const astEditView: Handler<'ast_edit'> = (ctx) => {
  const where = (ctx.input?.paths ?? []).filter((one) => one !== '').join('、')
  const ops = ctx.input?.ops ?? []
  const pats = ops.map((entry) => entry.pat).filter((entry): entry is string => given(entry) !== undefined)
  const request =
    pats.length === 0 ? NONE : [code(pats.map((pat, index) => `${String(index + 1)}. ${pat}`).join('\n'), 'text')]
  const subject = where === '' ? `${String(ops.length)} 处` : where

  return view('edit', `AST 改写 ${subject}`, subject, request, failOr(ctx, saidText(ctx)))
}
