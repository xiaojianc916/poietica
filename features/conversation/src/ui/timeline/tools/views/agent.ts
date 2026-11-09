import type { OmpTodoItem, OmpTodoPhase, OmpToolInput } from '@poietica/omp-types'
import type { Handler } from '../view-kit'
import { code, failOr, given, join, listOf, NONE, oneLine, prose, proseSaid, saidText, view } from '../view-kit'

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
function taskLine(task: OmpTodoItem): string {
  const box = task.status === 'completed' ? '- [x]' : task.status === 'abandoned' ? '- [~]' : '- [ ]'
  const note =
    task.status === 'blocked' && task.blocker !== undefined
      ? `（阻塞：${task.blocker}）`
      : (TASK_MARKS[task.status] ?? '')

  return `${box} ${task.content}${note}`
}

function checklistOf(phases: readonly OmpTodoPhase[]): string {
  const lines: string[] = []
  const many = phases.length > 1

  for (const entry of phases) {
    if (many && entry.name !== '' && entry.tasks.length > 0) {
      lines.push(lines.length === 0 ? `**${entry.name}**` : `\n**${entry.name}**`)
    }

    for (const task of entry.tasks) {
      lines.push(taskLine(task))
    }
  }

  return lines.join('\n')
}

// init 给分段的 list，append 给平铺的 items；归一成同一种形后只有一条画法。
function argPhases(input: OmpToolInput<'todo'> | undefined): readonly OmpTodoPhase[] {
  const items = input?.items ?? []

  if (items.length > 0) {
    return [
      {
        name: input?.phase ?? '',
        tasks: items.map((content) => ({ content, status: 'pending' })),
      },
    ]
  }

  return (input?.list ?? []).map((entry) => ({
    name: entry.phase ?? '',
    tasks: (entry.items ?? []).map((content) => ({ content, status: 'pending' as const })),
  }))
}

export const todoView: Handler<'todo'> = (ctx) => {
  const op = given(ctx.input?.op) ?? 'view'
  const task = given(ctx.input?.task) ?? ctx.input?.phase ?? ''
  // 产出的 phases 是落定后的清单（正本）；还没有产出时才照入参画。
  const board = checklistOf(ctx.details?.phases ?? [])
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

export const askView: Handler<'ask'> = (ctx) => {
  const questions = ctx.input?.questions ?? []
  const first = questions[0]
  const question = first?.question ?? ''
  const options = first?.options ?? []
  const body = options
    .map(
      (entry, index) =>
        `${String(index + 1)}. ${entry.label}${entry.description === undefined ? '' : ` —— ${entry.description}`}`,
    )
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

export const taskView: Handler<'task'> = (ctx) => {
  const single = ctx.input?.task ?? ''
  const batch = ctx.input?.tasks ?? []
  const named = given(ctx.input?.name)
  const agent = given(ctx.input?.agent) ?? 'task'
  const descriptions = batch
    .map((entry) => given(entry.description) ?? given(entry.task))
    .filter((entry): entry is string => entry !== undefined)
  const body =
    batch.length === 0
      ? single
      : batch
          .map((entry, index) => `## ${given(entry.name) ?? `#${String(index + 1)}`}\n\n${entry.task ?? ''}`)
          .join('\n\n')
  const shared = given(ctx.input?.context)
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

export const yieldView: Handler<'yield'> = (ctx) => {
  const kinds = listOf(ctx.input?.type)
  const error = given(ctx.input?.error)
  const data = ctx.input?.data

  return view(
    'other',
    error === undefined ? '交出结果' : '交出失败',
    kinds.join('、'),
    data === undefined ? NONE : [code(JSON.stringify(data, null, 2) ?? String(data), 'json')],
    failOr(ctx, saidText(ctx)),
  )
}

export const thinkView: Handler<'think'> = (ctx) =>
  view('other', oneLine(ctx.input?.thoughts ?? '内心独白'), '', NONE, NONE)

export const GOAL_OPS: Readonly<Record<string, string>> = {
  complete: '完成目标',
  create: '立下目标',
  drop: '放弃目标',
  get: '查看目标',
  resume: '继续目标',
}

export const goalView: Handler<'goal'> = (ctx) => {
  const op = given(ctx.input?.op) ?? 'get'
  const objective = ctx.input?.objective ?? ''
  const budget = ctx.input?.token_budget
  const head = GOAL_OPS[op] ?? op

  return view(
    'goal',
    join(head, oneLine(objective)) || head,
    oneLine(objective),
    budget === undefined ? NONE : [prose(`预算 ${String(budget)} token`)],
    failOr(ctx, proseSaid(ctx)),
  )
}

export const checkpointView: Handler<'checkpoint'> = (ctx) => {
  const goal = ctx.input?.goal ?? ''

  return view(
    'other',
    join('设立检查点', oneLine(goal)) || '设立检查点',
    oneLine(goal),
    goal === '' ? NONE : [prose(goal)],
    failOr(ctx, saidText(ctx)),
  )
}

export const rewindView: Handler<'rewind'> = (ctx) => {
  const report = ctx.input?.report ?? ''

  return view(
    'other',
    join('回退到检查点', oneLine(report)) || '回退到检查点',
    oneLine(report),
    report === '' ? NONE : [prose(report)],
    failOr(ctx, saidText(ctx)),
  )
}

export const contextNotesView: Handler<'context_notes'> = (ctx) => {
  const body = ctx.input?.text

  return body === undefined
    ? view('other', '查看上下文笔记', '', NONE, failOr(ctx, saidText(ctx)), 'result')
    : view('other', '更新上下文笔记', '', [prose(body)], failOr(ctx, saidText(ctx)))
}

export const newContextView: Handler<'new_context'> = (ctx) =>
  view('other', '开启新上下文', '', NONE, failOr(ctx, saidText(ctx)), 'result')

export const waitView: Handler<'wait'> = (ctx) =>
  view('other', '等待后台结果', '', NONE, failOr(ctx, saidText(ctx)), 'result')
