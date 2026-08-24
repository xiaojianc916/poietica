import type { SessionGoal } from '@poietica/agent-contract'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useSessionControlsActions, useThreadGoal } from '../session/session-controls-context'
import './goal-island.css'

/*
 * 目标模式的灵动岛。
 *
 * 它是这条对话的东西：挂在对话表头里，换 surface 就随表头一起卸载，
 * 不会跟到别处去。它不持有目标 —— 目标的唯一真相在 agent，本机的唯一
 * 副本在 SessionControlsStore，这里只读。
 *
 * 弹簧参数照苹果灵动岛的手感：形变一条弹簧、内容一条更快的弹簧，
 * 形状由 layout 动画连续接管，不做两个盒子的淡入淡出。
 */

const SHELL = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 } as const
const CONTENT = { type: 'spring', stiffness: 620, damping: 42, mass: 0.6 } as const

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** 单调毫秒数的显示格式。不涉及历法与时区，所以不引依赖。 */
function formatElapsed(total: number): string {
  const ms = Math.max(0, total)
  const hours = Math.floor(ms / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  const seconds = Math.floor((ms % MINUTE) / SECOND)
  const pad = (value: number) => String(value).padStart(2, '0')

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`
  }

  return `${minutes}:${pad(seconds)}`
}

/*
 * 走表。
 *
 * agent 累计的 wallClockMs 是真相，本机只把它推到此刻：推的依据是这份
 * 快照到达的时刻，不是另一个从零开始的计时器。目标不在跑时不推，也不醒。
 */
function useElapsed(goal: SessionGoal): number {
  const [, retick] = useState(0)
  const running = goal.status === 'active'

  useEffect(() => {
    if (!running) {
      return undefined
    }

    const timer = setInterval(() => retick((count) => count + 1), SECOND)

    return () => clearInterval(timer)
  }, [running])

  return goal.wallClockMs + (running ? Date.now() - goal.receivedAt : 0)
}

const STATUS_LABEL: Record<SessionGoal['status'], string> = {
  active: '推进中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已达成',
}

export interface GoalIslandProps {
  readonly threadId: string
}

export function GoalIsland({ threadId }: GoalIslandProps) {
  const goal = useThreadGoal(threadId)

  if (goal === undefined) {
    return null
  }

  return <Island goal={goal} threadId={threadId} />
}

function Island({ goal, threadId }: { readonly goal: SessionGoal; readonly threadId: string }) {
  const controls = useSessionControlsActions()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal.objective)
  const shell = useRef<HTMLDivElement>(null)
  const elapsed = useElapsed(goal)

  /* 点到岛外就收起来，与灵动岛一致。 */
  useEffect(() => {
    if (!expanded) {
      return undefined
    }

    const dismiss = (event: PointerEvent) => {
      if (shell.current !== null && !shell.current.contains(event.target as Node)) {
        setExpanded(false)
        setEditing(false)
      }
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false)
        setEditing(false)
      }
    }

    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onEscape)

    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onEscape)
    }
  }, [expanded])

  const exit = () => {
    setExpanded(false)
    void controls.selectControl(threadId, 'goal', 'off')
  }

  const commit = () => {
    const objective = draft.trim()

    if (objective.length === 0 || objective === goal.objective) {
      setEditing(false)
      return
    }

    setEditing(false)
    void controls.selectControl(threadId, 'goal', 'on', objective)
  }

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        animate={{ width: expanded ? 340 : 'auto' }}
        className="goal-island"
        data-expanded={expanded}
        data-status={goal.status}
        layout
        ref={shell}
        transition={SHELL}
      >
        <motion.button
          aria-expanded={expanded}
          className="goal-island__pill"
          layout="position"
          onClick={() => setExpanded((open) => !open)}
          transition={SHELL}
          type="button"
        >
          <motion.span className="goal-island__beacon" layout="position" />
          <motion.span className="goal-island__objective" layout="position">
            {goal.objective}
          </motion.span>
          <motion.span className="goal-island__clock" layout="position">
            {formatElapsed(elapsed)}
          </motion.span>
        </motion.button>

        <AnimatePresence initial={false} mode="popLayout">
          {expanded ? (
            <motion.div
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              className="goal-island__panel"
              exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
              initial={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
              key="panel"
              transition={CONTENT}
            >
              {editing ? (
                <div className="goal-island__edit">
                  <textarea
                    className="goal-island__input"
                    onChange={(event) => setDraft(event.target.value)}
                    rows={3}
                    value={draft}
                  />
                  <div className="goal-island__row">
                    <button
                      className="goal-island__action"
                      onClick={() => {
                        setDraft(goal.objective)
                        setEditing(false)
                      }}
                      type="button"
                    >
                      取消
                    </button>
                    <button
                      className="goal-island__action goal-island__action--accent"
                      onClick={commit}
                      type="button"
                    >
                      保存目标
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="goal-island__full">{goal.objective}</p>

                  {goal.completionCriterion === null ? null : (
                    <p className="goal-island__criterion">{goal.completionCriterion}</p>
                  )}

                  <dl className="goal-island__facts">
                    <div>
                      <dt>状态</dt>
                      <dd>{STATUS_LABEL[goal.status]}</dd>
                    </div>
                    <div>
                      <dt>运行</dt>
                      <dd>{formatElapsed(elapsed)}</dd>
                    </div>
                    <div>
                      <dt>轮次</dt>
                      <dd>{goal.turnsUsed}</dd>
                    </div>
                    <div>
                      <dt>Tokens</dt>
                      <dd>{goal.tokensUsed.toLocaleString()}</dd>
                    </div>
                  </dl>

                  <div className="goal-island__row">
                    <button
                      className="goal-island__action"
                      onClick={() => {
                        setDraft(goal.objective)
                        setEditing(true)
                      }}
                      type="button"
                    >
                      编辑目标
                    </button>
                    <button
                      className="goal-island__action goal-island__action--danger"
                      onClick={exit}
                      type="button"
                    >
                      退出目标模式
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </MotionConfig>
  )
}
