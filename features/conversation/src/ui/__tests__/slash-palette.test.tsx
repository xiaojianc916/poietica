import { describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@poietica/engine'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, KernelProvider } from '@poietica/ui-kernel'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { ComposerDrafts } from '../composer/drafts'
import { ComposerDraftsContext } from '../composer/drafts-context'
import type { PromptInputMessage } from '../composer/prompt'
import { ComposerActions } from '../composer/view/composer-actions'
import {
  PromptInput,
  PromptInputBody,
  PromptInputEditor,
  type PromptInputHandle,
  PromptInputToolbar,
} from '../composer/view/prompt-input'

/*
 * U-1：输入框敲下行首 `/` 弹命令面板（与 Claude Code / Codex 同一个手势）。
 * 回车执行（必填参数的先补参数）、Tab 只补全、Esc 收起；没给命令表的输入框（自动化、提问面板）不弹。
 */

const command = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  aliases: [],
  description: null,
  hint: null,
  source: 'builtin',
  subcommands: [],
  ...extra,
})

const COMMANDS: readonly SlashCommand[] = [
  command('compact', { description: '把较早的对话压缩成摘要，腾出上下文', hint: '[关注点]' }),
  command('context', { description: '查看上下文用量明细' }),
  command('add-dir', { description: '为这条对话添加工作目录', hint: '<路径>' }),
  command('review-diff', { description: '审查当前改动', source: 'file' }),
]

function statusBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send: (message: RpcMessage) => {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener({ jsonrpc: '2.0', id, result: { state: 'ready', reason: null, attempt: 0 } })
          }
        })
      }
    },
    onMessage: (listener: (message: RpcMessage) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pathForFile: () => 'C:/tmp/x',
  } satisfies WindowBridge
}

async function mount(slashCommands: readonly SlashCommand[] | undefined) {
  const kernel = createUiKernel({
    features: [],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'conversation.home', params: {} },
    bridge: statusBridge(),
  })
  await kernel.start()
  const submitted: PromptInputMessage[] = []
  let handle: PromptInputHandle | null = null

  function Composer(): ReactNode {
    return (
      <KernelProvider kernel={kernel}>
        <MotionConfig reducedMotion="always" skipAnimations>
          <ComposerDraftsContext value={new ComposerDrafts()}>
            <PromptInput
              onSubmit={(message) => {
                submitted.push(message)
              }}
              ref={(next) => {
                handle = next
              }}
              slashCommands={slashCommands}
            >
              <PromptInputBody>
                <PromptInputEditor placeholder="问我任何问题…" />
              </PromptInputBody>
              <PromptInputToolbar>
                <ComposerActions />
              </PromptInputToolbar>
            </PromptInput>
          </ComposerDraftsContext>
        </MotionConfig>
      </KernelProvider>
    )
  }

  const { container } = render(<Composer />)
  const editor = (): HTMLElement => {
    const node = container.querySelector<HTMLElement>('[contenteditable="true"]')
    expect(node).not.toBeNull()
    return node as HTMLElement
  }
  const labels = (): string[] =>
    [...container.querySelectorAll('.composer-palette__row .composer-palette__label')].map((n) => n.textContent ?? '')
  const draft = (): string => editor().textContent ?? ''
  return {
    container,
    draft,
    editor,
    labels,
    submitted,
    type: (text: string) => handle?.setText(text),
    key: (key: string) => fireEvent.keyDown(editor(), { key }),
  }
}

describe('斜杠命令面板', () => {
  test('敲下 `/` 弹出全部命令，自定义命令在前、带中文说明与参数提示', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/review-diff', '/compact', '/context', '/add-dir'])
      })
      const headings = [...view.container.querySelectorAll('.composer-palette__heading')].map((n) => n.textContent)
      expect(headings).toEqual(['自定义命令', '内置命令'])
      expect(view.container.textContent).toContain('把较早的对话压缩成摘要，腾出上下文')
      expect(view.container.textContent).toContain('[关注点]')
    } finally {
      cleanup()
    }
  })

  test('敲半截名字只剩匹配的；回车执行高亮那一条（放回 `/名字` 再提交）', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/comp')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/compact'])
      })
      view.key('Enter')
      await waitFor(() => {
        expect(view.submitted.map((message) => message.text)).toEqual(['/compact'])
      })
    } finally {
      cleanup()
    }
  })

  test('必填参数的命令回车只补全名字，等人写参数；Tab 一律只补全', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/add')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/add-dir'])
      })
      view.key('Enter')
      await waitFor(() => {
        expect(view.draft()).toBe('/add-dir ')
        expect(view.labels()).toEqual([])
      })

      view.type('/cont')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/context'])
      })
      view.key('Tab')
      await waitFor(() => {
        expect(view.draft()).toBe('/context ')
      })
      expect(view.submitted).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('Esc 收起后继续敲也不再弹；草稿离开斜杠再回来才重新出现', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/c')
      await waitFor(() => {
        expect(view.labels().length).toBeGreaterThan(0)
      })
      view.key('Escape')
      await waitFor(() => {
        expect(view.labels()).toEqual([])
      })
      view.type('/co')
      await Bun.sleep(20)
      expect(view.labels()).toEqual([])

      view.type('')
      await waitFor(() => {
        expect(view.draft()).toBe('')
      })
      view.type('/co')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/compact', '/context'])
      })
    } finally {
      cleanup()
    }
  })

  test('没有匹配的命令（路径、随手的斜杠）不弹面板，回车照常当一句话发', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/usr/bin')
      await Bun.sleep(20)
      expect(view.labels()).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('没给命令表的输入框：`/` 只是一个字', async () => {
    const view = await mount(undefined)
    try {
      view.type('/')
      await Bun.sleep(20)
      expect(view.labels()).toEqual([])
    } finally {
      cleanup()
    }
  })
})
