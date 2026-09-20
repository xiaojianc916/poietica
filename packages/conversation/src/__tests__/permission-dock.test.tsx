import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionDock } from '../surface/composer/permission-dock'
import type { PermissionItem } from '../timeline/timeline-contract'

function permission(overrides: Partial<PermissionItem> = {}): PermissionItem {
  return {
    type: 'permission',
    id: 'r0-permission-1',
    at: 0,
    turn: 0,
    requestId: 'request-1',
    title: 'write',
    kind: 'other',
    subject: '',
    locations: [],
    ...overrides,
  }
}

function render(item: PermissionItem, waiting = 1): string {
  return renderToStaticMarkup(<PermissionDock item={item} onResolve={() => {}} waiting={waiting} />)
}

describe('审批带', () => {
  it('三颗按钮就是 kap 的三种答复', () => {
    const markup = render(permission())

    expect(markup).toContain('批准')
    expect(markup).toContain('本次会话都批准')
    expect(markup).toContain('拒绝')
  })

  it('题面是 agent 送来的那一句，一个字不加', () => {
    const markup = render(permission())

    expect(markup).toContain('>write</span>')
    expect(markup).not.toContain('需要批准')
  })

  it('只有一个在等就不报序号，有第二个才报', () => {
    expect(render(permission())).not.toContain('assistant-approval__count')
    expect(render(permission(), 3)).toContain('1/3')
  })

  it('放行只涂一颗', () => {
    const markup = render(permission())

    expect(markup.match(/data-lead="true"/g)).toHaveLength(1)
  })

  it('印的是要批准的那件事，不是工具名', () => {
    const markup = render(permission({ title: 'Bash', kind: 'execute', subject: 'bun run check' }))

    expect(markup).toContain('bun run check')
  })
})
