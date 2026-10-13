import type { Handler } from '../view-kit'
import {
  bag,
  code,
  failOr,
  get,
  join,
  list,
  NONE,
  numb,
  oneLine,
  pick,
  prose,
  proseSaid,
  saidText,
  strings,
  view,
} from '../view-kit'

export const TODO_OPS: Readonly<Record<string, string>> = {
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

export const TASK_MARKS: Readonly<Record<string, string>> = {
  abandoned: '（已丢弃）',
  blocked: '（阻塞）',
  completed: '（完成）',
  in_progress: '（进行中）',
  pending: '',
}

// omp 清单分段、四档状态（比协议多一档「丢弃」），自己拼 GFM 任务清单。
export function taskLine(task: unknown): string {
  const content = pick(task, 'content') ?? ''
  const status = pick(task, 'status') ?? 'pending'
  const box = status === 'completed' ? '- [x]' : status === 'abandoned' ? '- [~]' : '- [ ]'
  const blocker = status === 'blocked' ? pick(task, 'blocker') : undefined
  const note = blocker === undefined ? (TASK_MARKS[status] ?? '') : `（阻塞：${blocker}）`

  return `${box} ${content}${note}`
}

export function checklistOf(phases: readonly unknown[]): string {
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
export function argPhases(input: unknown): readonly unknown[] {
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

export const todoView: Handler = (ctx) => {
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

export const askView: Handler = (ctx) => {
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
    [...(question === '' ? NONE : [prose(`**${question}**`)]), ...(body === '' ? NONE : [code(body, 'text')])],
    failOr(ctx, proseSaid(ctx)),
  )
}

export const taskView: Handler = (ctx) => {
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

export const yieldView: Handler = (ctx) => {
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

export const thinkView: Handler = (ctx) =>
  view('other', oneLine(pick(ctx.input, 'thoughts') ?? '内心独白'), '', NONE, NONE)

export const GOAL_OPS: Readonly<Record<string, string>> = {
  complete: '完成目标',
  create: '立下目标',
  drop: '放弃目标',
  get: '查看目标',
  resume: '继续目标',
}

export const goalView: Handler = (ctx) => {
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

export const checkpointView: Handler = (ctx) => {
  const goal = pick(ctx.input, 'goal') ?? ''

  return view(
    'other',
    join('设立检查点', oneLine(goal)) || '设立检查点',
    oneLine(goal),
    goal === '' ? NONE : [prose(goal)],
    failOr(ctx, saidText(ctx)),
  )
}

export const rewindView: Handler = (ctx) => {
  const report = pick(ctx.input, 'report') ?? ''

  return view(
    'other',
    join('回退到检查点', oneLine(report)) || '回退到检查点',
    oneLine(report),
    report === '' ? NONE : [prose(report)],
    failOr(ctx, saidText(ctx)),
  )
}

export const contextNotesView: Handler = (ctx) => {
  const body = get(ctx.input, 'text')

  return body === undefined
    ? view('other', '查看上下文笔记', '', NONE, failOr(ctx, saidText(ctx)), 'result')
    : view('other', '更新上下文笔记', '', [prose(typeof body === 'string' ? body : '')], failOr(ctx, saidText(ctx)))
}

export const newContextView: Handler = (ctx) =>
  view('other', '开启新上下文', '', NONE, failOr(ctx, saidText(ctx)), 'result')

export const waitView: Handler = (ctx) => view('other', '等待后台结果', '', NONE, failOr(ctx, saidText(ctx)), 'result')
