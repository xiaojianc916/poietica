import type { SessionConfigControl } from '@poietica/agent-contract'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerModeChip, composerModeRows } from '../composer/composer-actions'

const MODE: SessionConfigControl = {
  id: 'mode',
  label: 'Mode',
  purpose: 'mode',
  current: 'manual',
  choices: [
    { value: 'manual', label: 'Default' },
    { value: 'plan', label: 'Plan' },
    { value: 'auto', label: 'Auto' },
    { value: 'yolo', label: 'YOLO' },
  ],
}

function withCurrent(current: string): SessionConfigControl {
  return { ...MODE, current }
}

describe('批准方式的单一入口', () => {
  it('加号面板不再重复显示 Default、Auto 与 YOLO', () => {
    const rows = composerModeRows({
      controls: [MODE],
      onSelectControl: () => undefined,
    })

    expect(rows.map((row) => row.label)).toEqual(['Plan'])
  })

  it('额外模式胶囊不再重复显示 Auto 与 YOLO', () => {
    const render = (current: string) =>
      renderToStaticMarkup(
        <ComposerModeChip controls={[withCurrent(current)]} onSelect={() => undefined} />,
      )

    expect(render('manual')).toBe('')
    expect(render('auto')).toBe('')
    expect(render('yolo')).toBe('')
    expect(render('plan')).toContain('Plan')
  })
})
