import { describe, expect, test } from 'bun:test'
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
import type { ComposerCommand } from '../shared/model/commands'

/*
 * 输入框敲下行首 `/` 弹命令面板。面板分三个阶段，全由草稿推出来：
 *   1. 命令列表（按用途分组）；回车：不带参数 / 可选参数的直接执行，选项型进二级、必填参数停下来等人写；
 *   2. 选项型命令的二级列表（勾着当前值），选一项就执行；
 *   3. 文字参数的提示行，必填的没写选不动。
 * Tab 只补全、Esc 收起；没给命令表的输入框（自动化、提问面板）不弹。
 */

const command = (name: string, extra: Partial<ComposerCommand> = {}): ComposerCommand => ({
  name,
  aliases: [],
  description: '',
  group: 'conversation',
  input: { kind: 'none' },
  ...extra,
})

const COMMANDS: readonly ComposerCommand[] = [
  command('compact', {
    description: '把较早的对话压缩成摘要，腾出上下文',
    input: { kind: 'text', required: false, placeholder: '压缩时要保留的重点，可留空' },
  }),
  command('context', { description: '查看上下文用量明细' }),
  command('fast', {
    group: 'mode',
    description: '快速模式',
    input: {
      kind: 'choice',
      choices: [
        { value: 'on', label: '开启' },
        { value: 'off', label: '关闭' },
      ],
      current: 'off',
    },
  }),
  command('deploy', {
    group: 'custom',
    description: '部署到预发',
    input: { kind: 'text', required: true, placeholder: '环境' },
  }),
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

async function mount(slashCommands: readonly ComposerCommand[] | undefined) {
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
  const headings = (): string[] =>
    [...container.querySelectorAll('.composer-palette__heading')].map((n) => n.textContent ?? '')
  return {
    container,
    draft,
    editor,
    headings,
    labels,
    submitted,
    type: (text: string) => handle?.setText(text),
    key: (key: string) => fireEvent.keyDown(editor(), { key }),
  }
}

describe('斜杠命令面板', () => {
  test('敲下 `/` 按用途分组列出全部命令，带中文说明；选项型行尾是当前值', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/compact', '/context', '/fast', '/deploy'])
      })
      expect(view.headings()).toEqual(['对话', '模式', '自定义命令'])
      expect(view.container.textContent).toContain('把较早的对话压缩成摘要，腾出上下文')
      expect(view.container.querySelector('.composer-palette__trail')?.textContent).toBe('关闭 ›')
    } finally {
      cleanup()
    }
  })

  test('敲半截名字只剩匹配的；回车执行高亮那一条（可选参数不拦）', async () => {
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

  test('选项型命令回车进二级列表（勾着当前值），选一项就执行', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/fast')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/fast'])
      })
      view.key('Enter')
      await waitFor(() => {
        expect(view.draft()).toBe('/fast ')
        expect(view.labels()).toEqual(['开启', '关闭'])
      })
      const ticked = view.container.querySelector('.composer-palette__tick')?.parentElement
      expect(ticked?.querySelector('.composer-palette__label')?.textContent).toBe('关闭')
      view.key('Enter')
      await waitFor(() => {
        expect(view.submitted.map((message) => message.text)).toEqual(['/fast on'])
      })
    } finally {
      cleanup()
    }
  })

  test('二级列表按敲的字过滤；一项都对不上就收起', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/fast 关')
      await waitFor(() => {
        expect(view.labels()).toEqual(['关闭'])
      })
      view.type('/fast ultra')
      await waitFor(() => {
        expect(view.labels()).toEqual([])
      })
    } finally {
      cleanup()
    }
  })

  test('必填参数：回车只补名字，提示行没写参数时选不动，写了才执行', async () => {
    const view = await mount(COMMANDS)
    try {
      view.type('/dep')
      await waitFor(() => {
        expect(view.labels()).toEqual(['/deploy'])
      })
      view.key('Enter')
      await waitFor(() => {
        expect(view.draft()).toBe('/deploy ')
        expect(view.container.textContent).toContain('先写参数')
      })
      view.key('Enter')
      await Bun.sleep(20)
      expect(view.submitted).toEqual([])

      view.type('/deploy staging')
      await waitFor(() => {
        expect(view.container.textContent).toContain('回车执行')
      })
      view.key('Enter')
      await waitFor(() => {
        expect(view.submitted.map((message) => message.text)).toEqual(['/deploy staging'])
      })
    } finally {
      cleanup()
    }
  })

  test('Tab 一律只补全，不执行', async () => {
    const view = await mount(COMMANDS)
    try {
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

  test('没有匹配的命令（路径、随手的斜杠）不弹面板', async () => {
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
