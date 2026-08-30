import {
  DEFAULT_SCHEDULE,
  describeMoment,
  nextRunAfter,
  SCHEDULE_PRESETS,
  type ScheduleProblem,
  scheduleProblem,
} from '@poietica/automation'
import { cn } from '@poietica/design-system'
import { useState } from 'react'

/*
 * 「什么时候跑」这一块。
 *
 * 表达式是唯一真相。上一版是「档位 + 数量 + 单位 + 时刻」四个零件拼出一个判别
 * 联合，那套表示说不出「每周一」也说不出「每月 1 号」；现在输入框里那一段文字
 * 就是存下去的东西，预设只是往里填字，不是第二份状态。
 *
 * 时区不出现在这一屏，因为它不是一个可配置项：求值按此刻这台机器的时区走。
 * 预览那一句说的就是真的那个时刻，所以人看得见自己配的是不是想要的。
 *
 * 初值只在挂载时取一次 props：换一条自动化时编辑器那一层已经用 key 重挂过整棵树
 * （automations-surface.tsx 的 key={editing.id}），这里不需要再养一套同步逻辑。
 */

const PROBLEMS: Record<ScheduleProblem, string> = {
  neverRuns: '这段表达式永远不会到期。',
  tooFrequent: '比调度的心跳还密。最小粒度是一分钟，写得更密不会更快。',
  unreadable: '读不懂这段 crontab 表达式。',
}

const FIELD = cn(
  'h-[26px] w-40 rounded-lg bg-sidebar-accent/50 px-2',
  'font-mono text-xs tabular-nums text-foreground',
  'outline-none transition-colors',
  'hover:bg-sidebar-accent',
  'focus-visible:ring-2 focus-visible:ring-ring',
)

export interface AutomationScheduleFieldProps {
  readonly onChange: (schedule: string | null) => void
  readonly schedule: string | null
}

export function AutomationScheduleField({ onChange, schedule }: AutomationScheduleFieldProps) {
  /*
   * 切到「手动」再切回来，刚才填的那一段还在：它没被清空过，那是人刚刚写的东西。
   * 所以本地留一份表达式草稿，而交上去的是「手动就是 null」。
   */
  const [expression, setExpression] = useState(schedule ?? DEFAULT_SCHEDULE)
  const [timed, setTimed] = useState(schedule !== null)

  /* 每个 setter 都把改完之后的那一份算出来交上去：不用 effect 去追状态。 */
  function pickTimed(next: boolean): void {
    setTimed(next)
    onChange(next ? expression : null)
  }

  function pickExpression(next: string): void {
    setExpression(next)
    onChange(timed ? next : null)
  }

  const current = timed ? expression : null
  const problem = scheduleProblem(current)
  const next = problem === null ? nextRunAfter(current, Date.now()) : null

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-lg bg-sidebar-accent/50 p-0.5">
          {[false, true].map((entry) => (
            <button
              aria-pressed={timed === entry}
              className={cn(
                'rounded-[7px] px-3 py-1 text-xs transition-colors',
                timed === entry
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              key={String(entry)}
              onClick={() => {
                pickTimed(entry)
              }}
              type="button"
            >
              {entry ? '定时' : '手动'}
            </button>
          ))}
        </div>

        {timed ? (
          <input
            aria-label="crontab 表达式"
            autoComplete="off"
            className={FIELD}
            onChange={(event) => {
              pickExpression(event.target.value)
            }}
            spellCheck={false}
            value={expression}
          />
        ) : null}
      </div>

      {timed ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {SCHEDULE_PRESETS.map((preset) => (
            <button
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                expression === preset.expression
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )}
              key={preset.expression}
              onClick={() => {
                pickExpression(preset.expression)
              }}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* 预览不是装饰：表达式对不对、下一次落在哪，只有这句话说得出来。 */}
      <p className="mt-3 text-xs text-muted-foreground">
        {problem !== null
          ? PROBLEMS[problem]
          : next === null
            ? '不排期。只有你按下运行时才跑一次。'
            : `下一次 ${describeMoment(next)}`}
      </p>
    </div>
  )
}
