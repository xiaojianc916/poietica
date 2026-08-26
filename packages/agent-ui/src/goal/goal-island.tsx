import type { SessionGoal } from '@poietica/agent-contract'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useSecond } from '../primitives/tick'
import { HOUR, MINUTE, SECOND } from '../semantics/duration'
import { useSessionControlsActions, useThreadGoal } from '../session/session-controls-context'
import './goal-island.css'

/* 一条弹簧管完整形变：阻尼比 ≈0.93，近临界，落位不回弹。 */
const MORPH = { type: 'spring', stiffness: 260, damping: 30, mass: 1 } as const
const FADE = { duration: 0.16, ease: 'easeOut' } as const
const SHAPE = { collapsed: 999, expanded: 28 } as const

function formatElapsed(total: number): string {
  const ms = Math.max(0, total)
  const hours = Math.floor(ms / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  const seconds = Math.floor((ms % MINUTE) / SECOND)
  const pad = (value: number) => String(value).padStart(2, '0')

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

function useElapsed(goal: SessionGoal): number {
  const running = goal.status === 'active'
  const now = useSecond(running)

  return goal.wallClockMs + (running ? Math.max(now - goal.receivedAt, 0) : 0)
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

  return goal === undefined ? null : <Island goal={goal} threadId={threadId} />
}

function Island({ goal, threadId }: { readonly goal: SessionGoal; readonly threadId: string }) {
  const controls = useSessionControlsActions()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal.objective)
  const shell = useRef<HTMLDivElement>(null)
  const elapsed = useElapsed(goal)
  const statusLabel = STATUS_LABEL[goal.status]

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

    if (objective.length === 0) {
      return
    }

    if (objective === goal.objective) {
      setEditing(false)
      return
    }

    setEditing(false)
    void controls.selectControl(threadId, 'goal', 'on', objective)
  }

  return (
    <MotionConfig reducedMotion="user" transition={MORPH}>
      <motion.div
        animate={{ borderRadius: expanded ? SHAPE.expanded : SHAPE.collapsed }}
        className="goal-island"
        data-status={goal.status}
        layout
        ref={shell}
      >
        <motion.button
          aria-expanded={expanded}
          className="goal-island__pill"
          layout="position"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          <span aria-hidden="true" className="goal-island__beacon" />
          <span className="goal-island__objective">{goal.objective}</span>
          <span className="goal-island__clock">{formatElapsed(elapsed)}</span>
        </motion.button>

        <AnimatePresence initial={false} mode="popLayout">
          {expanded ? (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="goal-island__panel"
              exit={{ opacity: 0, y: -4 }}
              initial={{ opacity: 0, y: -4 }}
              key="panel"
              transition={{ opacity: FADE, y: MORPH }}
            >
              {editing ? (
                <div className="goal-island__edit">
                  <textarea
                    aria-label="目标内容"
                    // biome-ignore lint/a11y/noAutofocus: 由用户点击"编辑目标"触发，聚焦编辑框是预期行为
                    autoFocus
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
                    <section aria-label="达成条件" className="goal-island__criterion">
                      <span>达成条件</span>
                      <p>{goal.completionCriterion}</p>
                    </section>
                  )}

                  <dl className="goal-island__facts">
                    <div>
                      <dt>状态</dt>
                      <dd className="goal-island__status">
                        <span aria-hidden="true" className="goal-island__beacon" />
                        {statusLabel}
                      </dd>
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
