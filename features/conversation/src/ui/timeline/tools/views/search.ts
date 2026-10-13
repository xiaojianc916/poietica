import type { Handler } from '../view-kit'
import { at, dot, failOr, join, list, NONE, numb, pick, prose, saidText, view } from '../view-kit'

export const grepView: Handler = (ctx) => {
  const pattern = pick(ctx.input, 'pattern') ?? ''
  const where = pick(ctx.input, 'path') ?? pick(ctx.details, 'searchPath') ?? '.'
  const count = numb(ctx.details, 'matchCount')

  return view(
    'search',
    `搜索 ${pattern}`,
    pattern,
    [prose(`在 ${at(where)} 里匹配 ${at(pattern)}`)],
    failOr(ctx, [...saidText(ctx), ...(count === undefined ? NONE : [prose(`${String(count)} 处匹配`)])]),
    'result',
  )
}

export const astGrepView: Handler = (ctx) => {
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
export const globView: Handler = (ctx) => {
  const pattern = pick(ctx.input, 'path') ?? ''
  const count = numb(ctx.details, 'fileCount')

  return view(
    'search',
    `按模式查找 ${pattern}`,
    pattern,
    [prose(`按 ${at(pattern)} 找文件`)],
    failOr(ctx, [...saidText(ctx), ...(count === undefined ? NONE : [prose(`${String(count)} 个文件`)])]),
    'result',
  )
}

export const findView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''
  const where = pick(ctx.input, 'path')
  const hits = list(ctx.details, 'hits').length

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

export const lspView: Handler = (ctx) => {
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
