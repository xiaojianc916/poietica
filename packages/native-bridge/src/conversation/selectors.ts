import type { AgentConfigChoice, AgentConfigControl, AgentGoal } from '@poietica/contract'
import type {
  SessionConfigChoice,
  SessionConfigControl,
  SessionGoal,
  SessionGoalStatus,
} from '@poietica/conversation'

function detailOf(detail: string | null): { detail?: string } {
  return detail === null ? {} : { detail }
}
function choiceOf(native: AgentConfigChoice): SessionConfigChoice {
  return { value: native.value, label: native.label, ...detailOf(native.detail) }
}
export function controlOf(native: AgentConfigControl): SessionConfigControl {
  return {
    id: native.id,
    label: native.label,
    purpose: native.purpose,
    ...(native.appliesOnSubmit ? { appliesOnSubmit: true as const } : {}),
    current: native.current,
    choices: native.choices.map(choiceOf),
    ...detailOf(native.detail),
  }
}
export function goalOf(reported: AgentGoal | null): SessionGoal | null {
  if (reported === null) {
    return null
  }

  return {
    objective: reported.objective,
    completionCriterion: reported.completionCriterion,
    status: reported.status as SessionGoalStatus,
    turnsUsed: reported.turnsUsed,
    tokensUsed: reported.tokensUsed,
    wallClockMs: reported.wallClockMs,
    receivedAt: performance.now(),
  }
}
