import type { Handler } from '../view-kit'
import { at, dot, failOr, given, join, NONE, prose, saidText, view } from '../view-kit'

export const grepView: Handler<'grep' | 'search'> = (ctx) => {
  const pattern = ctx.input?.pattern ?? ''
  const where = given(ctx.input?.path) ?? given(ctx.details?.searchPath) ?? '.'
  const count = ctx.details?.matchCount

  return view(
    'search',
    `搜索 ${pattern}`,
    pattern,
    [prose(`在 ${at(where)} 里匹配 ${at(pattern)}`)],
    failOr(ctx, [...saidText(ctx), ...(count === undefined ? NONE : [prose(`${String(count)} 处匹配`)])]),
    'result',
  )
}

export const astGrepView: Handler<'ast_grep'> = (ctx) => {
  const pat = ctx.input?.pat ?? ''
  const where = given(ctx.input?.path) ?? '.'

  return view(
    'search',
    `AST 搜索 ${pat}`,
    pat,
    [prose(`在 ${at(where)} 里按 AST 模式匹配 ${at(pat)}`)],
    failOr(ctx, saidText(ctx)),
    'result',
  )
}

export const globView: Handler<'glob'> = (ctx) => {
  const pattern = ctx.input?.path ?? ''
  const count = ctx.details?.fileCount

  return view(
    'search',
    `按模式查找 ${pattern}`,
    pattern,
    [prose(`按 ${at(pattern)} 找文件`)],
    failOr(ctx, [...saidText(ctx), ...(count === undefined ? NONE : [prose(`${String(count)} 个文件`)])]),
    'result',
  )
}

export const findView: Handler<'find'> = (ctx) => {
  const query = ctx.input?.query ?? ''
  const where = given(ctx.input?.path)
  const hits = ctx.details?.hits.length ?? 0

  return view(
    'search',
    `语义查找 ${query}`,
    query,
    [prose(join(`按行为描述找 ${at(query)}`, where === undefined ? undefined : `范围 ${at(where)}`))],
    failOr(ctx, [...saidText(ctx), ...(hits === 0 ? NONE : [prose(`命中 ${String(hits)} 处`)])]),
    'result',
  )
}

export const LSP_ACTIONS: Readonly<Record<string, string>> = {
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

export const lspView: Handler<'lsp'> = (ctx) => {
  const action = ctx.input?.action ?? ''
  const file = ctx.input?.file ?? ''
  const symbol = given(ctx.input?.symbol) ?? given(ctx.input?.query) ?? ''
  const said = LSP_ACTIONS[action] ?? '语言服务请求'
  const subject = dot(file, symbol)

  return view(
    'read',
    join(said, subject) || said,
    subject,
    [prose(join(`${at(file === '' ? '.' : file)} 上${said}`, given(ctx.details?.serverName)))],
    failOr(ctx, saidText(ctx)),
    'result',
  )
}
