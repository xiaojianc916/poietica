import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 行首状态点的定位规则。
 *
 * 这不是纯样式偏好：StateDot 自己声明了 `position: relative`（它是给「点里再画一层」用的），
 * 而会话行的这条规则用同一个单类权重去改成 absolute —— 两份样式表谁后加载谁赢。设计系统
 * 那份晚到时，点就退回文件流、缩进到标题的位置（真机截图里抓到的就是这个）。
 * 所以判据钉在**选择器权重**上：带行前缀，绝不与 .ui-state-dot 打平。
 */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'assistant-threads.css'), 'utf8')

describe('会话行状态点的定位（样式护栏）', () => {
  test('定位规则带行前缀，压得过 StateDot 自己的 position: relative', () => {
    expect(css).toContain('.assistant-thread > .assistant-thread__status {')
    expect(css).not.toMatch(/(?:^|\n)\.assistant-thread__status\s*\{/u)
  })

  test('点是绝对定位、垂直居中；两种外径各自对齐到行首图标中线', () => {
    const block = /\.assistant-thread > \.assistant-thread__status \{([^}]*)\}/u.exec(css)?.[1] ?? ''
    expect(block).toContain('position: absolute')
    expect(block).toContain('translateY(-50%)')
    expect(block).toContain('var(--ui-row-icon-size) - 10px')

    const ongoing =
      /\.assistant-thread > \.assistant-thread__status\[data-state='ongoing'\] \{([^}]*)\}/u.exec(css)?.[1] ?? ''
    expect(ongoing).toContain('var(--ui-row-icon-size) - 14px')
  })

  test('待答短标签和相对时间同一个开关：悬停时一起让位给动作按钮', () => {
    const pending = /\.assistant-thread__pending \{([^}]*)\}/u.exec(css)?.[1] ?? ''
    expect(pending).toContain('opacity: var(--thread-trail-time, 1)')
    expect(pending).toContain('pointer-events: none')
  })
})
