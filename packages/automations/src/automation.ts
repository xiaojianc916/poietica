import type { Automation } from '@poietica/native-bridge'
import { Cron } from 'croner'

/**
 * 自动化的纯函数层。
 *
 * 没有 React、没有 IPC、没有状态：这一层只回答「下一次什么时候到期」「这堆
 * 记录合起来是什么样子」「这条日程念出来是什么」。形状本身不在这里声明 ——
 * 它的权威是 Rust 侧的 commands/automations.rs，经由生成绑定过来。
 *
 * 日历归 croner。cron 语法、闰年、月末、夏令时切换那一天到底有几个小时 ——
 * 这些是已经被解决透了的问题，手写一遍必然漏边界。它也是这一层唯一的运行时
 * 依赖：领域的其余部分（状态、管线、不变量）仍然自己掌控。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SUMMARY_WINDOW = 7 * DAY

/**
 * 只用来算日期的 Cron。
 *
 * 不传回调，所以它不会自己起表 —— croner 把「找下一个匹配的日期」当作一等
 * 用法，这里要的正是那个。也不传 timezone：不传就按求值那一刻的系统时区算，
 * 而「每天九点」说的就是此刻这台机器上的九点。
 *
 * 读不懂就是 null。构造函数会为非法表达式抛错，这里收住 —— 界面在保存前就
 * 把它挡掉了（scheduleProblem），能走到这里的只有被外部改坏的目录文件。
 */
function jobOf(schedule: string | null): Cron | null {
  if (schedule === null) {
    return null
  }

  try {
    return new Cron(schedule)
  } catch {
    return null
  }
}

/**
 * 从 from 起，这条日程下一次该在什么时候跑。
 *
 * 手动（null）返回 null，而不是一个「永远不到的极大值」—— 那种写法会在此后
 * 每一处比较里活下来，并且总有一天会被某个减法算成一个荒谬的间隔。
 *
 * 没有「锚点」参数，也不需要第二个函数。cron 表达式本身就是相位：错过几次都
 * 不改变下一次落在哪里，所以「从上一次排定的时刻起算」和「从现在起算」是同一
 * 个答案。此前这里是 nextRunAfter 与 nextOccurrence 两条路，那是固定间隔留下
 * 的债 —— 间隔没有相位，得靠一个存下来的锚点顶着。关机错过的次数照旧不逐次
 * 补，直接跨到之后的第一个，与 Kubernetes CronJob 的 misfire 处理同法。
 */
export function nextRunAfter(schedule: string | null, from: number): string | null {
  return jobOf(schedule)?.nextRun(new Date(from))?.toISOString() ?? null
}

interface AutomationSummary {
  readonly total: number
  readonly succeeded: number
  readonly failed: number
}

/** 顶部那三块牌子。窗口 7 天。 */
export function summarize(
  automations: readonly Automation[],
  now: number = Date.now(),
): AutomationSummary {
  let succeeded = 0
  let failed = 0

  for (const automation of automations) {
    for (const run of automation.runs) {
      if (now - Date.parse(run.startedAt) > SUMMARY_WINDOW) {
        continue
      }

      if (run.outcome === 'succeeded') {
        succeeded += 1
      } else {
        failed += 1
      }
    }
  }

  return { total: automations.length, succeeded, failed }
}

/** 心跳是 30 秒（commands/automations.rs 的 TICK），所以承诺的最小粒度是分钟。 */
const MIN_SPAN = MINUTE

export type ScheduleProblem = 'unreadable' | 'neverRuns' | 'tooFrequent'

/**
 * 这段表达式能不能用。能用返回 null。
 *
 * 三种不能用，各自说清是哪一种：读不懂、永远不会到、比调度的心跳还密。最后
 * 那一条是真的会骗人 —— 心跳 30 秒一跳，写「每秒」不会更快，只会让人以为自己
 * 配的东西没生效，那是承诺一个兑现不了的精度。
 *
 * 用 croner 自己算出的前两次相隔多久来判，不去数它有几段：段数、别名与扩展
 * 语法归 croner 所有，这一层不把那门语言重新定义一遍。
 */
export function scheduleProblem(schedule: string | null): ScheduleProblem | null {
  if (schedule === null) {
    return null
  }

  const job = jobOf(schedule)

  if (job === null) {
    return 'unreadable'
  }

  const [first, second] = job.nextRuns(2)

  if (first === undefined) {
    return 'neverRuns'
  }

  if (second !== undefined && second.getTime() - first.getTime() < MIN_SPAN) {
    return 'tooFrequent'
  }

  return null
}

/** 新建时输入框里的那一段。「默认是每天九点」只写一处。 */
export const DEFAULT_SCHEDULE = '0 9 * * *'

/**
 * 界面上那几颗预设。
 *
 * 只是往输入框里填一段文字，不是第二份状态：表达式始终是唯一真相。它们存在
 * 的理由是 cron 原文对人不友好，而「每天九点」这种最常见的意图不该逼人先学
 * 一门语法 —— GitHub Actions 与 Vercel 的界面上摆的也是这个组合。
 */
export const SCHEDULE_PRESETS: readonly {
  readonly expression: string
  readonly label: string
}[] = [
  { expression: '0 * * * *', label: '每小时' },
  { expression: '0 9 * * *', label: '每天 09:00' },
  { expression: '0 9 * * 1', label: '每周一 09:00' },
  { expression: '0 9 1 * *', label: '每月 1 号 09:00' },
]

/**
 * 这条日程念出来是什么。
 *
 * 定时那一档念出来就是表达式原文。croner 的 JS 版没有 describe()，而自己写一个
 * cron 到人话的翻译器，等于把一整门语言的语义在这一层再实现一遍，还得跟着它的
 * 扩展语法一起腐烂。GitHub Actions、Vercel 与 Kubernetes 的界面上摆的也都是原文，
 * 旁边配一句「下一次是什么时候」—— 那一句由 describeMoment 负责，它比任何措辞
 * 都准，因为它算的是真的那个时刻。
 */
export function describeSchedule(schedule: string | null): string {
  return schedule ?? '手动'
}

/**
 * 两份会话设置是不是同一份。
 *
 * 编辑器判「有没有改过」。键集合取并集，不是拿一边的键去查另一边 —— 那样
 * 「删掉一项」会被判成没变，保存按钮永远是灰的。
 *
 * 两边都必须是收过的形状（sessionConfigOf 的产物）。收窄入参不是洁癖：生成
 * 绑定里 sessionConfig 是 Partial<Record<..>> | undefined，直接递进来编译就
 * 过不去 —— 于是「忘记归一」这件事由编译器拦，不靠人记得。
 */
export function sameSessionConfig(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] !== right[key]) {
      return false
    }
  }

  return true
}

/**
 * 一份还没有身份的自动化：编辑器里能改的全部，正好就是这四样。
 *
 * 住在纯函数层而不是 store 里 —— 它是这个领域的词汇，不是某一个状态容器的
 * 私事。store 收它、模板摊出它、编辑器读它，三方共用一个名字，就不会长出
 * 三份形状相近的初始化结构。
 */
export interface AutomationDraft {
  readonly title: string
  readonly prompt: string
  /** crontab 表达式；null 就是手动，只在人按下运行时跑一次。 */
  readonly schedule: string | null
  /**
   * 这条自动化要给自己那次运行改掉的会话设置。
   *
   * 键是 agent 报的 controlId，值是它自己的词汇。这一层不认识这些字符串，
   * 也不该认识 —— 校验的唯一时机是下发那一刻，由 agent 自己说了算。
   *
   * 空表是一个正常取值，不是「还没填」：不改动，用 agent 当下的默认。模板
   * 给的就是空表，所以编辑器打开时显示的是 agent 此刻报的组合，人按下保存，
   * 存进去的就是屏幕上那三颗胶囊 —— 界面上没有「跟随默认」这一档，这里也
   * 没有第三态。
   */
  readonly sessionConfig: Readonly<Record<string, string>>
}

/** 直接新建时表单里的东西。和模板给的那一份是同一种形状，不是另一条初始化路径。 */
export const BLANK_DRAFT: AutomationDraft = {
  title: '',
  prompt: '',
  schedule: DEFAULT_SCHEDULE,
  sessionConfig: {},
}

/**
 * 把线上那个形状收成界面能用的形状。
 *
 * 生成绑定里 sessionConfig 是 Partial<Record<..>> | undefined，那是 BTreeMap
 * 加 #[serde(default)] 的忠实翻译：老盘上的记录整张表都可能缺席，每个值也
 * 标成可选。线上如此没有错，但界面不该一路背着它走 —— 边界上收一次，往里
 * 只有 Record<string, string>。
 *
 * 此前编辑器自己在 pickedFrom 里收一次、判「有没有改过」时忘了收、运行时
 * 那一侧干脆没收：同一件事在三处各做一遍，漏一遍就是一个类型错误。
 */
export function sessionConfigOf(automation: Automation): Readonly<Record<string, string>> {
  const picked: Record<string, string> = {}

  for (const [id, value] of Object.entries(automation.sessionConfig ?? {})) {
    if (value !== undefined) {
      picked[id] = value
    }
  }

  return picked
}

/** 把一条已有的自动化摊回成草稿。编辑器要的初值就是它。 */
export function draftOf(automation: Automation): AutomationDraft {
  return {
    title: automation.title,
    prompt: automation.prompt,
    schedule: automation.schedule,
    sessionConfig: sessionConfigOf(automation),
  }
}

/*
 * 相对时间交给平台。
 *
 * Intl.RelativeTimeFormat 是标准库：手写一张「秒/分/时/天」的表，等于自己承担
 * 复数、语言与取整三件事，而这三件事运行时已经做完了。
 */
const RELATIVE = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

const UNITS = [
  { unit: 'day', span: DAY },
  { unit: 'hour', span: HOUR },
  { unit: 'minute', span: MINUTE },
] as const

export function describeMoment(at: string, now: number = Date.now()): string {
  const delta = Date.parse(at) - now

  for (const { unit, span } of UNITS) {
    if (Math.abs(delta) >= span) {
      return RELATIVE.format(Math.trunc(delta / span), unit)
    }
  }

  return RELATIVE.format(0, 'minute')
}

/** 「最近运行」那一列。没跑过就是没跑过，不编一个占位出来。 */
export function latestRun(automation: Automation): Automation['runs'][number] | null {
  return automation.runs[0] ?? null
}
