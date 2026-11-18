import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { AGENT_FACE_COLORS, AgentFace, agentColor, agentFaceColor } from '../agent-face'

/* 瓦片脸的身份与状态：机身色按编号环取、没有编号按名字散列，状态只改表情不动机身。 */

describe('瓦片脸', () => {
  it('编号在九色环上循环，同名同色', () => {
    expect(agentColor(0, 'x')).toBe(AGENT_FACE_COLORS[0])
    expect(agentColor(9, 'x')).toBe(AGENT_FACE_COLORS[0])
    expect(agentColor(10, 'x')).toBe(AGENT_FACE_COLORS[1])
    expect(agentColor(undefined, 'General Purpose')).toBe(agentFaceColor('General Purpose'))
  })

  it('状态只改表情：跑着是竖瞳扫视，完成是笑眼，失败是丧眼', () => {
    const running = render(<AgentFace name="a" status="running" />)
    const done = render(<AgentFace name="a" status="done" />)
    const failed = render(<AgentFace name="a" status="failed" />)

    expect(running.container.querySelector('svg')?.getAttribute('data-face-state')).toBe('scanning')
    expect(done.container.querySelector('svg')?.getAttribute('data-expression')).toBe('happy')
    expect(failed.container.querySelector('svg')?.getAttribute('data-expression')).toBe('sad')
    expect(running.container.querySelector('rect')?.getAttribute('rx')).toBe('7')
  })

  it('完成时多画一枚勾角标，机身色不变', () => {
    const plain = render(<AgentFace name="a" status="done" />)
    const marked = render(<AgentFace name="a" showCompletionMark status="done" />)

    expect(plain.container.querySelector('[data-subagent-completion-badge]')).toBeNull()
    expect(marked.container.querySelector('[data-subagent-completion-badge]')).not.toBeNull()
    expect(marked.container.querySelector('svg')?.style.getPropertyValue('--agent-face-body')).toBe(
      plain.container.querySelector('svg')?.style.getPropertyValue('--agent-face-body'),
    )
  })
})
