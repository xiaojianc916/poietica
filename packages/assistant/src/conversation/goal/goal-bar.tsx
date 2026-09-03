import type { SessionGoal } from '@poietica/conversation'
import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import { Check, CirclePause, CirclePlay, Goal, Pencil, Trash2, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { focusOnMount } from '../primitives/focus-on-mount'
import { useSessionControlsActions, useThreadGoal } from '../session/session-controls-context'
import {
  GOAL_CONTROL_ID,
  GOAL_DISABLED,
  GOAL_ENABLED,
  GOAL_PAUSED,
  GOAL_RESUMED,
} from './goal-control'
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

type MutationResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

type GoalAction = () => Promise<MutationResult>

interface GoalBarViewProps {
  readonly goal: SessionGoal
  readonly onClear: GoalAction
  readonly onEdit: (objective: string) => Promise<MutationResult>
  readonly onPause: GoalAction
  readonly onResume: GoalAction
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

function GoalBarView({ goal, onClear, onEdit, onPause, onResume }: GoalBarViewProps) {
  const presentation = goalBarPresentation(goal.status)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal.objective)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const pendingRef = useRef(false)

  useEffect(() => {
    setEditing(false)
    setDraft(goal.objective)
    setActionError(null)
  }, [goal.objective])

  useEffect(() => {
    if (actionError === null) {
      return undefined
    }
    const timer = setTimeout(() => setActionError(null), ACTION_ERROR_LIFETIME_MS)
    return () => clearTimeout(timer)
  }, [actionError])

  const runAction = useCallback(async (action: GoalAction) => {
    if (pendingRef.current) {
      return undefined
    }
    pendingRef.current = true
    setPending(true)
    setActionError(null)
    try {
      const result = await action()
      if (!result.ok) {
        setActionError(result.error)
      }
      return result
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      setActionError(error)
      return { ok: false, error }
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [])

  const commit = useCallback(async () => {
    const objective = draft.trim()
    if (objective.length === 0) {
      return
    }
    const result = await runAction(() => onEdit(objective))
    if (result?.ok) {
      setEditing(false)
    }
  }, [draft, onEdit, runAction])

  const clear = useCallback(async () => {
    await runAction(onClear)
  }, [onClear, runAction])

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
              <Check aria-hidden size={14} strokeWidth={1.5} />
            </ActionButton>
            <ActionButton
              disabled={pending}
              label="取消编辑"
              onClick={() => {
                setDraft(goal.objective)
                setEditing(false)
              }}
            >
              <X aria-hidden size={14} strokeWidth={1.5} />
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
          <Goal aria-hidden size={14} strokeWidth={1.5} />
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
                void runAction(onPause)
              }}
            >
              <CirclePause aria-hidden size={14} strokeWidth={1.5} />
            </ActionButton>
          ) : null}
          {presentation.toggle === 'resume' ? (
            <ActionButton
              disabled={pending}
              label="恢复目标"
              onClick={() => {
                void runAction(onResume)
              }}
            >
              <CirclePlay aria-hidden size={14} strokeWidth={1.5} />
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
            <Pencil aria-hidden size={14} strokeWidth={1.5} />
          </ActionButton>
          <ActionButton
            disabled={pending}
            label="清除目标"
            onClick={() => {
              void clear()
            }}
          >
            <Trash2 aria-hidden size={14} strokeWidth={1.5} />
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

export interface GoalBarProps {
  readonly threadId: string
}

export function GoalBar({ threadId }: GoalBarProps) {
  const goal = useThreadGoal(threadId)
  const controls = useSessionControlsActions()

  const mutate = useCallback(
    (value: string, input?: string) =>
      controls.selectControl(threadId, GOAL_CONTROL_ID, value, input),
    [controls, threadId],
  )

  if (goal === undefined || goal.status === 'complete') {
    return null
  }

  return (
    <GoalBarView
      goal={goal}
      onClear={() => mutate(GOAL_DISABLED)}
      onEdit={(objective) => mutate(GOAL_ENABLED, objective)}
      onPause={() => mutate(GOAL_PAUSED)}
      onResume={() => mutate(GOAL_RESUMED)}
    />
  )
}
