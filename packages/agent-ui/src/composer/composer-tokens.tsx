import './composer-tokens.css'

import type { ReactNode } from 'react'
import { CloseIcon, GoalIcon, SkillIcon, SwarmIcon } from '../primitives/icons'
import { usePromptInputActions, usePromptInputDraft } from './prompt-input'

/*
 * 这一句带着的指令，一枚一枚摆在正文上方。
 *
 * 只画草稿：指令的唯一所有者是 PromptInput，撤下也只经过它交出的那三个动作。
 * 落成文字是送出那一刻的事（composePrompt），这里不拼任何字。
 */

interface TokenProps {
  readonly dropLabel: string
  readonly icon: ReactNode
  readonly label: string
  readonly onDrop: () => void
}

function Token({ dropLabel, icon, label, onDrop }: TokenProps) {
  return (
    <li className="composer-token">
      <span aria-hidden="true" className="composer-token__icon">
        {icon}
      </span>

      <span className="composer-token__label">{label}</span>

      <button
        aria-label={dropLabel}
        className="composer-token__drop"
        onClick={onDrop}
        type="button"
      >
        <CloseIcon aria-hidden="true" />
      </button>
    </li>
  )
}

export function ComposerTokens() {
  const { dropSkill, dropSwarm, reviseGoal } = usePromptInputActions()
  const { directives } = usePromptInputDraft()
  const { goal, skill, swarm } = directives

  if (skill === null && goal === null && !swarm) {
    return null
  }

  return (
    <ul className="composer-tokens" data-slot="composer-tokens">
      {skill === null ? null : (
        <Token
          dropLabel={`移除技能 ${skill.title}`}
          icon={<SkillIcon />}
          label={skill.title}
          onDrop={dropSkill}
        />
      )}

      {goal === null ? null : (
        <Token dropLabel="改写目标" icon={<GoalIcon />} label={goal} onDrop={reviseGoal} />
      )}

      {swarm ? (
        <Token dropLabel="退出蜂群模式" icon={<SwarmIcon />} label="蜂群模式" onDrop={dropSwarm} />
      ) : null}
    </ul>
  )
}
