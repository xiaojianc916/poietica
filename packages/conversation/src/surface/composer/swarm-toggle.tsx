import './swarm-toggle.css'

import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import { Check } from 'lucide-react'
import type { SessionConfigControl } from '../../agent/config'

/*
 * Swarm 那一格，画成上下文栏最右端的一枚勾选。
 *
 * 它此前是会话设置菜单里的一行。搬到栏里是因为它答的问题与菜单不同：菜单里每一
 * 行说「这一句由谁答、想多久」，它说「这一句怎么跑」—— 与左边那两枚 chip（项目
 * 说在哪、分支说在哪条线上）合起来才是「这一次执行的上下文」。形状也随之换成勾
 * 选框：开与关一眼可辨，不必先点开菜单才看得见自己此刻是不是并行。
 *
 * 菜单里那一行在同一次改动里删掉了（session-controls 的 sessionControlRows）：
 * 一个控制只有一个住处。值本身仍然只有一份 —— control.current 是 agent 报的，
 * 这里只负责把改动发出去。
 *
 * 语义是「切换按钮」而不是 checkbox：它是一颗按钮，开合用 aria-pressed 报，与
 * question-panel 的选项同一套（勾选框只是它的画法）。
 */

/** Swarm 在会话控件里的 id；正本是 kap-client 的 selector_patch。 */
export const SWARM_CONTROL_ID = 'swarm'

export function swarmControlOf(
  controls: readonly SessionConfigControl[],
): SessionConfigControl | undefined {
  return controls.find((control) => control.id === SWARM_CONTROL_ID)
}

export interface SwarmToggleProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
}

export function SwarmToggle({ controls, onSelect }: SwarmToggleProps) {
  const control = swarmControlOf(controls)

  /* agent 没报这一格就没有它 —— 与分支 chip 同一条规矩，这里不画空态。 */
  if (control === undefined) {
    return null
  }

  const enabled = control.current === 'on'
  /* 气泡的正文是 agent 自己给的说明（开启那一档的 detail），不另写一套话。 */
  const hint =
    control.choices.find((choice) => choice.value === 'on')?.detail ??
    control.detail ??
    control.label

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-pressed={enabled}
            className="swarm-toggle"
            onClick={() => {
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
