import { describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpCatalogEntry } from '../../contract'
import { groupRows, registryServerRows } from '../catalog'
import { CatalogGrid } from '../catalog-grid'

/*
 * 在线目录那一行的渲染：卡片要画出来、必填没填时安装键点不动、填上之后能装。
 * 与精选卡片同一套 DOM（.catalog-card），所以这里只钉「目录特有」的那几件。
 */

function entry(over: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    id: 'x/one',
    name: 'x-one',
    title: 'One',
    description: '说明',
    homepage: null,
    sourceType: 'remote',
    useCount: 7,
    verified: true,
    inputs: [],
    warnings: [],
    config: { type: 'http', url: 'https://one.test/mcp' },
    ...over,
  }
}

function draw(entries: readonly McpCatalogEntry[], install: (name: string, body: unknown) => void): void {
  render(
    <CatalogGrid
      action={{
        install: (name, body) => {
          install(name, body)
        },
      }}
      groups={groupRows(registryServerRows(entries, []))}
      taken={new Set()}
    />,
  )
}

describe('在线目录卡片', () => {
  test('画在「在线目录」那一组里，标题与说明都在', () => {
    draw([entry()], () => undefined)

    expect(screen.getByText('在线目录')).not.toBeNull()
    expect(screen.getByText('One')).not.toBeNull()
    expect(screen.getByText('说明')).not.toBeNull()

    cleanup()
  })

  test('必填项没填：安装键点不动，并说明缺什么', () => {
    const installed: unknown[] = []
    draw(
      [
        entry({
          inputs: [
            { key: 'TOKEN', label: 'TOKEN', required: true, sensitive: true, defaultValue: null, description: null },
          ],
          config: { type: 'stdio', command: 'npx', args: ['--config', '{}'] },
        }),
      ],
      (name, body) => installed.push({ name, body }),
    )

    const button = screen.getByRole('button', { name: '安装' })

    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(installed).toEqual([])

    /* 展开输入区，填上之后就能装。 */
    fireEvent.click(screen.getByRole('button', { name: /需要填写/ }))
    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: 'secret' } })

    expect(screen.getByRole('button', { name: '安装' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))

    expect(installed).toEqual([
      {
        name: 'x-one',
        body: { type: 'stdio', command: 'npx', args: ['--config', JSON.stringify({ TOKEN: 'secret' })] },
      },
    ])

    cleanup()
  })

  test('没有输入时直接可装，正文就是目录给的那一份', () => {
    const installed: { name: string; body: unknown }[] = []
    draw([entry()], (name, body) => installed.push({ name, body }))

    fireEvent.click(screen.getByRole('button', { name: '安装' }))

    expect(installed).toEqual([{ name: 'x-one', body: { type: 'http', url: 'https://one.test/mcp' } }])

    cleanup()
  })

  test('已装的条目画状态，不再给安装键', () => {
    render(
      <CatalogGrid
        action={{ install: () => undefined }}
        groups={groupRows(registryServerRows([entry({ name: 'taken' })], [{ name: 'taken' }]))}
        taken={new Set(['taken'])}
      />,
    )

    expect(screen.getByText('已安装')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()

    cleanup()
  })
})
