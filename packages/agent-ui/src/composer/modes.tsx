import type { ReactNode } from 'react'
import { GoalIcon, PlanIcon } from '../primitives/icons'

/*
 * 输入姿态目录：加号菜单里可开关的问法。
 *
 * 一条姿态生效即改两处投影：输入框的占位词、工具条上一颗可摘的胶囊。
 * 开关状态归草稿唯一所有者 PromptInput；这里只有目录，不持有状态。
 */
export interface ComposerMode {
  readonly id: string
  readonly label: string
  /** 菜单行里跟在名字后面的那句淡字。 */
  readonly description: string
  /** 姿态生效时输入框的占位词。 */
  readonly placeholder: string
  readonly icon: ReactNode
}

export const COMPOSER_MODES: readonly ComposerMode[] = [
  {
    id: 'goal',
    label: '目标',
    description: '设置要持续追求的目标',
    placeholder: '描述你的目标，定义可测量的成果…',
    icon: <GoalIcon aria-hidden="true" />,
  },
  {
    id: 'plan',
    label: '计划模式',
    description: '先给出计划，确认后再执行',
    placeholder: '描述要完成的工作，先出计划再动手…',
    icon: <PlanIcon aria-hidden="true" />,
  },
]
