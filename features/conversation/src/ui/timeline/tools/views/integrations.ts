import { describeTool } from '../../../shared/tools/tool-vocabulary'
import type { Handler, OmpToolView } from '../view-kit'
import {
  at,
  code,
  detailsOf,
  dot,
  failOr,
  get,
  join,
  list,
  NONE,
  oneLine,
  pick,
  prose,
  proseSaid,
  saidText,
  strings,
  view,
} from '../view-kit'

/*
 * hub 是 18.2.11 的协调面入口，钉 18.3.0 后新会话不再报它（收成 `wait`）；留着是因为磁盘上有 18.2.11 写下的会话，重开旧对话时要从 jsonl 回放。
 */
export const HUB_OPS: Readonly<Record<string, string>> = {
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

export const hubView: Handler = (ctx) => {
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

export const searchView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''
  const recency = pick(ctx.input, 'recency')
  const sources = list(get(ctx.details, 'response'), 'sources').length

  return view(
    'fetch',
    `联网搜索 ${query}`,
    query,
    [prose(join(`搜索 ${at(query)}`, recency === undefined ? undefined : `时限 ${recency}`))],
    failOr(ctx, [...proseSaid(ctx), ...(sources === 0 ? NONE : [prose(`${String(sources)} 条来源`)])]),
    'result',
  )
}

export const GITHUB_OPS: Readonly<Record<string, string>> = {
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

export const githubView: Handler = (ctx) => {
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

export const debugView: Handler = (ctx) => {
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
    [...(expression === undefined ? NONE : [code(expression, 'text')]), ...(subject === '' ? NONE : [prose(subject)])],
    failOr(ctx, saidText(ctx)),
  )
}

export const securityScanView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const head = action.replaceAll('_', ' ')
  const subject = pick(ctx.input, 'target_kind') ?? pick(ctx.input, 'plan_id') ?? pick(ctx.input, 'scan_id') ?? ''

  return view(
    'other',
    join('安全扫描', dot(head, subject)) || '安全扫描',
    subject,
    NONE,
    failOr(ctx, saidText(ctx)),
    'result',
  )
}

export const MEMORY_EDITS: Readonly<Record<string, string>> = {
  forget: '遗忘记忆',
  invalidate: '作废记忆',
  update: '修订记忆',
}

export const memoryEditView: Handler = (ctx) => {
  const op = pick(ctx.input, 'op') ?? ''
  const id = pick(ctx.input, 'id') ?? ''
  const head = MEMORY_EDITS[op] ?? op

  return view('other', join(head, id) || head, id, NONE, failOr(ctx, saidText(ctx)), 'result')
}

/*
 * 一个工具十种动作：折叠行上先说是哪一个动作，再说是对哪一个库/符号 —— 合成一句「使用 ida」就什么都看不出来。判据取自上游自己那张表。
 */
export const IDA_ACTIONS: Readonly<Record<string, string>> = {
  list: '列出数据库',
  open: '打开数据库',
  save: '保存数据库',
  close: '关闭数据库',
  exec: '执行 IDA 脚本',
  rename: '重命名符号',
  comment: '添加注释',
  set_type: '设置类型',
  make_function: '标记为函数',
}

export const idaView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const head = IDA_ACTIONS[action] ?? action
  const db = pick(ctx.input, 'db') ?? ''
  const target = pick(ctx.input, 'target') ?? ''
  const subject = target === '' ? db : target

  /* 类别取 other：十种动作横跨读、改、执行三档，归任何一档都是替上游猜。 */
  return view('other', join(head, subject) || 'IDA', subject, NONE, failOr(ctx, saidText(ctx)), 'result')
}

export const retainView: Handler = (ctx) => {
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

export const recallView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''

  return view('search', `回忆 ${query}`, query, NONE, failOr(ctx, proseSaid(ctx)), 'result')
}

export const reflectView: Handler = (ctx) => {
  const query = pick(ctx.input, 'query') ?? ''

  return view('other', `反思 ${query}`, query, NONE, failOr(ctx, proseSaid(ctx)), 'result')
}

export const learnView: Handler = (ctx) => {
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

export const MANAGE_SKILLS: Readonly<Record<string, string>> = {
  create: '新建技能',
  delete: '删除技能',
  update: '更新技能',
}

export const manageSkillView: Handler = (ctx) => {
  const action = pick(ctx.input, 'action') ?? ''
  const name = pick(ctx.input, 'name') ?? ''
  const head = MANAGE_SKILLS[action] ?? action
  const description = pick(ctx.input, 'description')
  const body = pick(ctx.input, 'body')

  return view(
    'skill',
    join(head, name) || head,
    name,
    [...(description === undefined ? NONE : [prose(description)]), ...(body === undefined ? NONE : [prose(body)])],
    failOr(ctx, saidText(ctx)),
  )
}

export const imageGenView: Handler = (ctx) => {
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

/* 产品自己的智能界面指南：参数永远是空对象，能看的只有产出。flow 让面板像运行命令那样竖着摞，而不是两个页签。 */
export const intelligentUiGuideView: Handler = (ctx) => view('other', '', '', NONE, failOr(ctx, proseSaid(ctx)), 'flow')

export const ttsView: Handler = (ctx) => {
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

export const vibeSpawnView: Handler = (ctx) => {
  const cli = pick(ctx.input, 'cli') ?? ''
  const prompt = pick(ctx.input, 'prompt') ?? ''

  return view('delegate', `启动 vibe 会话（${cli}）`, cli, [prose(prompt)], failOr(ctx, proseSaid(ctx)))
}

export const vibeSendView: Handler = (ctx) => {
  const session = pick(ctx.input, 'session') ?? ''

  return view(
    'delegate',
    `发给 vibe 会话 ${session}`,
    session,
    [prose(pick(ctx.input, 'message') ?? '')],
    failOr(ctx, proseSaid(ctx)),
  )
}

export const vibeWaitView: Handler = (ctx) => {
  const sessions = strings(ctx.input, 'sessions')
  const subject = sessions.length === 0 ? '全部在跑的会话' : sessions.join('、')

  return view('delegate', `等待 vibe 会话 ${subject}`, subject, NONE, failOr(ctx, proseSaid(ctx)), 'result')
}

export const vibeKillView: Handler = (ctx) => {
  const session = pick(ctx.input, 'session') ?? ''

  return view('delegate', `终止 vibe 会话 ${session}`, session, NONE, failOr(ctx, proseSaid(ctx)), 'result')
}

export const vibeListView: Handler = (ctx) =>
  view('delegate', '查看 vibe 会话', '', NONE, failOr(ctx, proseSaid(ctx)), 'result')

/* xd:// 设备不是顶层工具，只能经 `write xd://<name>` 到达；这几个名字要认得，否则屏幕上只剩裸名字。 */
export const deviceView = (said: string): Handler =>
  function device(ctx) {
    return view('other', said, '', NONE, failOr(ctx, proseSaid(ctx)), 'result')
  }

/** MCP 结果里那一对（tool-bridge 的 { serverName, mcpToolName }）；拿不到就是空。 */
export const mcpServerOf = (output: unknown): string | undefined => mcpPairOf(output)?.[0]

export const mcpToolOf = (output: unknown): string | undefined => mcpPairOf(output)?.[1]

export function mcpPairOf(output: unknown): readonly [string, string] | undefined {
  const details = detailsOf(output)
  const server = pick(details, 'serverName')
  const tool = pick(details, 'mcpToolName')

  return server === undefined || tool === undefined ? undefined : [server, tool]
}

/*
 * 拆名字是**猜**，omp 自己给的那一对才是答案：`createMCPToolName` 铸的名字会剥掉重复的服务器前缀、按 64 字符上限加哈希后缀 ——
 * `mcp__chrome_devtools_list_pages` 里那个下划线不是分隔符，拆错就把服务器名说成 "chrome"。真答案在产出的 details 里；拿不到就退回前缀，不猜边界。
 */
export function mcpView(name: string, input: unknown, server?: string, tool?: string): OmpToolView {
  const subject = server === undefined ? '' : tool === undefined ? server : `${server} · ${tool}`
  const guess = describeTool(input)

  return {
    known: true,
    kind: guess.kind,
    invokedTool: name,
    scheme: '',
    headline: subject === '' ? name : subject,
    subject: subject === '' ? guess.subject : subject,
    shape: 'result',
    background: false,
    request: NONE,
    response: NONE,
  }
}

/*
 * 表里每个名字都是 omp 真的会报出来的那一个：内建与隐藏工具（builtin-names.ts，search 是 grep 的历史别名）、
 * 官方视图表登记的别名（apply_patch / puppeteer / js / python / notebook，老会话存着的名字要认得）、
 * eval 的 prelude（browser / computer）、omp 注册的 CustomTool（generate_image / tts / vibe_*）、
 * 以及 xd:// 设备（report_issue / resolve / reject / propose，经 write 委派到达）。
 */
