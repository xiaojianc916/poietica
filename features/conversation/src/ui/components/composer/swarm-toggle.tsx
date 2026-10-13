import './swarm-toggle.css'

import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import { Check } from 'lucide-react'
import type { SessionConfigControl } from '../../agent/config'

/* 值只有一份：control.current 由 agent 报，这里只把改动发出去。语义是切换按钮，用 aria-pressed 报开合（与 question-panel 的选项同一套），勾选框只是它的画法。 */

/** omp 的桥不报这一格，所以恒不渲染；留着是本仓纪律——控件不删，由 agent 报没报决定画不画。 */
export const SWARM_CONTROL_ID = 'swarm'

export function swarmControlOf(controls: readonly SessionConfigControl[]): SessionConfigControl | undefined {
  return controls.find((control) => control.id === SWARM_CONTROL_ID)
}

export interface SwarmToggleProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
  /** 未确认：画法不变，只是点不动。见 permission-picker 同名入参。 */
  readonly pending?: boolean | undefined
}

export function SwarmToggle({ controls, onSelect, pending }: SwarmToggleProps) {
  const control = swarmControlOf(controls)

  /* agent 没报这一格就不画；与分支 chip 同一条规矩，不留空态。 */
  if (control === undefined) {
    return null
  }

  const enabled = control.current === 'on'
  /* 气泡正文取 agent 给的说明，不另写一套话。 */
  const hint = control.choices.find((choice) => choice.value === 'on')?.detail ?? control.detail ?? control.label

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-busy={pending ? true : undefined}
            aria-disabled={pending ? true : undefined}
            aria-pressed={enabled}
            className="swarm-toggle"
            onClick={() => {
              /* 点不动但画法照旧：不能靠 disabled，那会连画法一起改掉。 */
              if (pending) {
                return
              }

              onSelect(control.id, enabled ? 'off' : 'on')
            }}
            type="button"
          >
            <span aria-hidden="true" className="swarm-toggle__box">
              <Check aria-hidden="true" className="swarm-toggle__check" />
            </span>

            <span className="swarm-toggle__label">{control.label}</span>
          </button>
        }
      />

      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  )
}
