import type { ReactNode } from 'react'
import { GoalIcon, PlanIcon } from '../primitives/icons'

/*
 * 输入姿态目录：加号菜单里可开关的问法。
 *
 * 一条姿态生效即改三处投影：输入框的占位词、工具条上一颗可摘的胶囊、发送时
 * 打头的指令行。开关状态归草稿唯一所有者 PromptInput；这里只有目录，不持有
 * 状态。指令走 prompt 正文，因为 ACP 的一句话只有内容块这一条通道 —— 会话级
 * 的档位（模型、思考深度、agent 自报的模式）另有 SessionConfig 那条线。
 */
export interface ComposerMode {
  readonly id: string
  readonly label: string
  /** 菜单行里跟在名字后面的那句淡字。 */
  readonly description: string
  /** 姿态生效时输入框的占位词。 */
  readonly placeholder: string
  /** 发送时替这条姿态说的话，排在人话之前。 */
  readonly directive: string
  readonly icon: ReactNode
}

export const COMPOSER_MODES: readonly ComposerMode[] = [
  {
    id: 'goal',
    label: '目标',
    description: '设置要持续追求的目标',
    placeholder: '描述你的目标，定义可测量的成果…',
    directive: '下面是一个需要持续追求的目标：先拆成可测量的成果，此后每一轮都对照它校准。',
    icon: <GoalIcon aria-hidden="true" />,
  },
  {
    id: 'plan',
    label: '计划模式',
    description: '先给出计划，确认后再执行',
    placeholder: '描述要完成的工作，先出计划再动手…',
    directive: '先给出完整的分步计划并停下等待确认；未经确认不要执行任何改动。',
    icon: <PlanIcon aria-hidden="true" />,
  },
]
