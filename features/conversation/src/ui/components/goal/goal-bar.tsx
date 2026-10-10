import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import { Check, CirclePause, CirclePlay, Goal, Pencil, Trash2, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionGoal } from '../../agent/goal'
import { describeFailure } from '../../failure'
import { focusOnMount } from '../primitives/focus-on-mount'
import type { GoalAction, GoalActionHandler, GoalActionResult } from './goal-control'
import './goal-bar.css'

export type GoalBarToggle = 'pause' | 'resume' | null

export interface GoalBarPresentation {
  readonly label: string
  readonly toggle: GoalBarToggle
}

const ACTION_ERROR_LIFETIME_MS = 4_500

const PRESENTATION: Record<SessionGoal['status'], GoalBarPresentation | null> = {
  active: { label: '进行中的目标', toggle: 'pause' },
  paused: { label: '已暂停的目标', toggle: 'resume' },
  blocked: { label: '受阻的目标', toggle: null },
  complete: null,
}

export function goalBarPresentation(status: SessionGoal['status']): GoalBarPresentation | null {
  return PRESENTATION[status]
}

/** 在途时又点了一下：不下发、不亮错（按钮本来就 disabled，这一条只防连点穿透）。 */
const IN_FLIGHT: GoalActionResult = { ok: false, error: '' }

/** 目标动作的状态与出口：目标栏与任务浮层的目标区块共用同一份（审查 R-10）。 */
export interface GoalActions {
  /** 有一个动作在途：目标栏的按钮一起 disabled。 */
  readonly pending: boolean
  /** 上一个动作失败的那句话；ACTION_ERROR_LIFETIME_MS 后自动消失，目标换了也不再显示。 */
  readonly error: string | null
  /** 下发一个动作。一次只走一个：在途时直接返回 IN_FLIGHT（不排队、不亮错）。 */
  readonly run: (action: GoalAction) => Promise<GoalActionResult>
}

/**
 * 目标动作的钩子（审查 R-10）。
 *
 * 状态挂在**调用方**（AssistantSurface）而不是目标栏里：任务浮层的暂停 / 继续也走这里，
 * 它失败的那句话才有地方显示（目标栏），两处的按钮也不会各自连发。
 */
export function useGoalActions(onAction: GoalActionHandler, objective: string | undefined): GoalActions {
  const [pending, setPending] = useState(false)
  /* 失败记在当时那个目标名下：目标换了（或没了），那句话自然不再显示 */
  const [failure, setFailure] = useState<GoalFailure | null>(null)
  const pendingRef = useRef(false)

  useEffect(() => {
    if (failure === null) {
      return undefined
    }
    const timer = setTimeout(() => setFailure(null), ACTION_ERROR_LIFETIME_MS)
    return () => clearTimeout(timer)
  }, [failure])

  const run = useCallback(
    async (action: GoalAction): Promise<GoalActionResult> => {
      if (pendingRef.current) {
        return IN_FLIGHT
      }
      pendingRef.current = true
      setPending(true)
      setFailure(null)
      try {
        const result = await onAction(action)
        if (!result.ok) {
          setFailure({ objective, message: result.error })
        }
        return result
      } catch (cause) {
        /* 出口按约定永不 reject；万一违约，也不能让按钮卡在 pending、让失败无声 */
        const message = describeFailure(cause)
        setFailure({ objective, message })
        return { ok: false, error: message }
      } finally {
        pendingRef.current = false
        setPending(false)
      }
    },
    [objective, onAction],
  )

  const error = failure !== null && failure.objective === objective ? failure.message : null
  return useMemo(() => ({ pending, error, run }), [pending, error, run])
}

interface GoalFailure {
  readonly objective: string | undefined
  readonly message: string
}

interface GoalBarViewProps {
  readonly goal: SessionGoal
  readonly actions: GoalActions
}

interface ActionButtonProps {
  readonly children: ReactNode
  readonly disabled: boolean
  readonly label: string
  readonly onClick: () => void
}

function ActionButton({ children, disabled, label, onClick }: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            className="goal-bar__icon-button"
            disabled={disabled}
            onClick={onClick}
            type="button"
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function GoalBarView({ goal, actions }: GoalBarViewProps) {
  const presentation = goalBarPresentation(goal.status)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal.objective)
  const { error: actionError, pending, run } = actions

  useEffect(() => {
    setEditing(false)
    setDraft(goal.objective)
  }, [goal.objective])

  const commit = useCallback(async () => {
    const objective = draft.trim()
    if (objective.length === 0) {
      return
    }
    /* 正文没变：直接收起，不发请求（引擎那边同正文本来也什么都不做） */
    if (objective === goal.objective) {
      setEditing(false)
      return
    }
    const result = await run({ kind: 'edit', objective })
    if (result.ok) {
      setEditing(false)
    }
  }, [draft, goal.objective, run])

  if (presentation === null) {
    return null
  }

  if (editing) {
    return (
      <div className="goal-bar__dock" data-goal-bar>
        <div className="goal-bar">
          <input
            aria-label="目标内容"
            className="goal-bar__input"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commit()
              } else if (event.key === 'Escape') {
                setDraft(goal.objective)
                setEditing(false)
              }
            }}
            ref={focusOnMount}
            type="text"
            value={draft}
          />
          {actionError === null ? null : (
            <span className="goal-bar__error" role="alert">
              {actionError}
            </span>
          )}
          <div className="goal-bar__actions">
            <ActionButton
              disabled={pending || draft.trim().length === 0}
              label="保存目标"
              onClick={() => {
                void commit()
              }}
            >
              <Check aria-hidden size={14} />
            </ActionButton>
            <ActionButton
              disabled={pending}
              label="取消编辑"
              onClick={() => {
                setDraft(goal.objective)
                setEditing(false)
              }}
            >
              <X aria-hidden size={14} />
            </ActionButton>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="goal-bar__dock" data-goal-bar>
      <div className="goal-bar">
        <span className="goal-bar__glyph">
          <Goal aria-hidden size={14} />
        </span>
        <span className="goal-bar__label">{presentation.label}</span>
        <span className="goal-bar__objective">{goal.objective}</span>
        {actionError === null ? null : (
          <span className="goal-bar__error" role="alert">
            {actionError}
          </span>
        )}
        <div className="goal-bar__actions">
          {presentation.toggle === 'pause' ? (
            <ActionButton
              disabled={pending}
              label="暂停目标"
              onClick={() => {
                void run({ kind: 'pause' })
              }}
            >
              <CirclePause aria-hidden size={14} />
            </ActionButton>
          ) : null}
          {presentation.toggle === 'resume' ? (
            <ActionButton
              disabled={pending}
              label="恢复目标"
              onClick={() => {
                void run({ kind: 'resume' })
              }}
            >
              <CirclePlay aria-hidden size={14} />
            </ActionButton>
          ) : null}
          <ActionButton
            disabled={pending}
            label="编辑目标"
            onClick={() => {
              setDraft(goal.objective)
              setEditing(true)
            }}
          >
            <Pencil aria-hidden size={14} />
          </ActionButton>
          <ActionButton
            disabled={pending}
            label="清除目标"
            onClick={() => {
              void run({ kind: 'clear' })
            }}
          >
            <Trash2 aria-hidden size={14} />
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

export interface GoalBarProps {
  /** 这条对话此刻的目标；没有目标是 undefined（整条不画）。 */
  readonly goal: SessionGoal | undefined
  /**
   * 目标动作的状态与出口（useGoalActions 的返回值，由 AssistantSurface 持有，任务浮层共用同一份）。
   * 暂停 / 继续 / 改正文 / 清除各走自己的 RPC（审查 R-10）；失败在这一条上亮 role=alert。
   */
  readonly actions: GoalActions
}

/*
 * 目标面板（「进行中的目标 <正文>」那一条）。
 *
 * 数据与动作都**从上面交进来**：目标的事实住在 Core 的控件通道（`Controls.goalSnapshot`，
 * 由 `stores.controls` 持有）；动作走 `actions.run`，等 Core 真的答复了才算完 ——
 * 不在本地猜状态（「已暂停」要等引擎报回来的快照）。
 */
export function GoalBar({ goal, actions }: GoalBarProps) {
  if (goal === undefined || goal.status === 'complete') {
    return null
  }

  return <GoalBarView actions={actions} goal={goal} />
}
