import { describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, defineUiFeature, KernelProvider } from '@poietica/ui-kernel'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { type ReactNode, useRef } from 'react'
import { composerToolkitSources } from '../../ui-api'
import { NEW_THREAD_KEY } from '../composer/composer-store'
import { ComposerDrafts } from '../composer/drafts'
import { ComposerDraftsContext } from '../composer/drafts-context'
import { createLiveComposers, type LiveComposers, LiveComposersContext } from '../composer/live-composers'
import type { PromptInputMessage } from '../composer/prompt'
import { ComposerActions, composerPaletteGroups } from '../composer/view/composer-actions'
import {
  PromptInput,
  PromptInputBody,
  PromptInputEditor,
  type PromptInputHandle,
  PromptInputSubmit,
  PromptInputToolbar,
} from '../composer/view/prompt-input'

/*
 * happy-dom 的 `Element.animate` 不推进时间轴，动画半途被取消时 motion reject 一个没人接的 `finished`
 * （AbortError），足以判整个用例失败（真机不会）。用 `MotionConfig skipAnimations` 而不是改系统偏好 ——
 * 后者在 motion 内首次读取时就缓存，同进程里再改已经晚了。
 */

function statusBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send: (message: RpcMessage) => {
      if (
        'id' in message &&
        typeof message.id === 'number' &&
        'method' in message &&
        message.method === 'core.getStatus'
      ) {
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

async function harness(): Promise<{
  readonly renderComposer: (
    onSubmit: (message: PromptInputMessage) => void,
    options?: { readonly initialText?: string; readonly submitDisabled?: boolean; readonly onEngage?: () => void },
  ) => {
    readonly container: HTMLElement
    readonly handle: () => PromptInputHandle | null
    readonly setInitialText: (text: string) => void
  }
  readonly liveComposers: LiveComposers
  readonly unmount: () => void
}> {
  const provider = defineUiFeature({
    id: 'test-provider',
    setup: (ctx) => {
      ctx.contribute(composerToolkitSources, {
        id: 'test.source',
        ensure: () => undefined,
        read: () => ({
          skills: [{ name: '翻译', description: '翻一下', source: 'user' }],
          mcpServers: [],
        }),
        subscribe: () => () => undefined,
      })
    },
  })
  const kernel = createUiKernel({
    features: [provider],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'conversation.home', params: {} },
    bridge: statusBridge(),
  })
  await kernel.start()

  const drafts = new ComposerDrafts()
  const liveComposers = createLiveComposers()
  const containers: HTMLElement[] = []

  return {
    renderComposer: (onSubmit, options = {}) => {
      let handle: PromptInputHandle | null = null

      function Composer({ initialText }: { readonly initialText?: string | undefined }): ReactNode {
        const ref = useRef<PromptInputHandle | null>(null)
        const groups = composerPaletteGroups({
          controls: [],
          mcpServers: [],
          onSelectControl: () => undefined,
          skills: [{ name: '翻译', description: '翻一下', source: 'user' }],
        })

        return (
          <KernelProvider kernel={kernel}>
            <MotionConfig reducedMotion="always" skipAnimations>
              <ComposerDraftsContext value={drafts}>
                <LiveComposersContext value={liveComposers}>
                  <PromptInput
                    groups={groups}
                    initialText={initialText}
                    onEngage={options.onEngage}
                    onSubmit={onSubmit}
                    ref={(next) => {
                      ref.current = next
                      handle = next
                    }}
                    submitDisabled={options.submitDisabled === true}
                  >
                    <PromptInputBody>
                      <PromptInputEditor placeholder="问我任何问题…" />
                    </PromptInputBody>
                    <PromptInputToolbar>
                      <ComposerActions />
                      <PromptInputSubmit />
                    </PromptInputToolbar>
                  </PromptInput>
                </LiveComposersContext>
              </ComposerDraftsContext>
            </MotionConfig>
          </KernelProvider>
        )
      }

      const view = render(<Composer initialText={options.initialText} />)
      containers.push(view.container)

      return {
        container: view.container,
        handle: () => handle,
        setInitialText: (text: string) => view.rerender(<Composer initialText={text} />),
      }
    },
    liveComposers,
    unmount: () => {
      cleanup()
      containers.length = 0
    },
  }
}

/*
 * 性能方案 P4：对话页靠这一格判断「人开始写了」再预热会话。只是挂上去（看一眼对话）不能报 ——
 * 那等于又回到挂载即开会话；拿到焦点、拖进文件才报。
 */
describe('开始写（onEngage）', () => {
  test('挂载不报；编辑器拿到焦点、往框里拖东西才报', async () => {
    let engaged = 0
    const harnessed = await harness()

    try {
      const { container } = harnessed.renderComposer(() => undefined, {
        onEngage: () => {
          engaged += 1
        },
      })
      expect(engaged).toBe(0)

      const editor = container.querySelector<HTMLElement>('[contenteditable="true"]')
      expect(editor).not.toBeNull()
      fireEvent.focusIn(editor!)
      expect(engaged).toBe(1)

      const shell = container.querySelector<HTMLElement>('[data-slot="prompt-input"]')
      expect(shell).not.toBeNull()
      fireEvent.drop(shell!)
      expect(engaged).toBe(2)
    } finally {
      harnessed.unmount()
    }
  })
})

describe('从加号面板到提交', () => {
  test('技能那一行落进正文，发送时 skills 里带着它的名字', async () => {
    const closed: PromptInputMessage[] = []
    const harnessed = await harness()

    try {
      const { container, handle } = harnessed.renderComposer((message) => {
        closed.push(message)
      })

      /* 技能记号本身不满足提交条件，得先往正文里写一句话。 */
      handle()?.setText('帮我翻一下')

      /* 先写正文再翻面板：正文里那一句不该被吞掉。 */
      const plus = container.querySelector<HTMLButtonElement>('button[aria-label="添加内容"]')
      expect(plus).not.toBeNull()
      fireEvent.click(plus!)

      await waitFor(() => {
        expect(container.textContent ?? '').toContain('翻译')
      })
      const row = [...container.querySelectorAll<HTMLButtonElement>('.composer-palette__row')].find((button) =>
        button.textContent?.includes('翻译'),
      )
      expect(row).not.toBeUndefined()
      fireEvent.mouseDown(row!)

      /* 记号经 Lexical 的 update 插入，那一次更新在微任务里落地。 */
      await waitFor(() => {
        expect(container.querySelector('.assistant-prompt-chip')).not.toBeNull()
      })

      const form = container.querySelector('form')
      expect(form).not.toBeNull()
      fireEvent.submit(form!)

      expect(closed).toHaveLength(1)
      expect(closed[0]?.text).toContain('帮我翻一下')
      expect(closed[0]?.skills).toEqual([{ name: '翻译' }])
    } finally {
      /* 等面板的退场动画走完再拆，否则 happy-dom 里半途取消会抛 AbortError（真机不会）。 */
      await Bun.sleep(400)
      harnessed.unmount()
    }
  })

  /*
   * 项目必选（用户裁决）：还没有选项目时发送键是灰的，Enter 也不提交，草稿原样留在输入框里 ——
   * 只把按钮画灰、Enter 却还能发，是最难解释的一种「禁用」。
   */
  test('禁止提交时：发送键 disabled，Enter 不发也不清空草稿', async () => {
    const closed: PromptInputMessage[] = []
    const harnessed = await harness()

    try {
      const { container, handle } = harnessed.renderComposer(
        (message) => {
          closed.push(message)
        },
        { submitDisabled: true },
      )

      const submit = container.querySelector<HTMLButtonElement>('button[data-slot="prompt-input-submit"]')
      expect(submit).not.toBeNull()
      expect(submit!.disabled).toBe(true)

      handle()?.setText('这一句先留着')

      const editor = container.querySelector<HTMLElement>('[data-slot="prompt-input-editor"]')
      expect(editor).not.toBeNull()

      /* Lexical 的更新在微任务里落地：等正文真的进了编辑器再敲 Enter。 */
      await waitFor(() => {
        expect(editor?.textContent ?? '').toContain('这一句先留着')
      })
      fireEvent.keyDown(editor!, { key: 'Enter' })

      await waitFor(() => {
        expect(closed).toHaveLength(0)
      })
      /* 草稿还在：选好项目之后这一句照样能发出去。 */
      expect(editor?.textContent ?? '').toContain('这一句先留着')
    } finally {
      harnessed.unmount()
    }
  })
})

/*
 * 草稿存在 store、正文活在 Lexical 里：盘上草稿是异步读回来的，可能晚于输入框挂载。
 * 空编辑器要能装回它；人一旦动手，后到的盘上正文不能再盖掉手写的那一句。
 */
describe('盘上草稿与编辑器', () => {
  test('盘上草稿晚到：编辑器还空着就装进去', async () => {
    const harnessed = await harness()

    try {
      const view = harnessed.renderComposer(() => undefined)
      const editor = view.container.querySelector<HTMLElement>('[data-slot="prompt-input-editor"]')
      expect(editor).not.toBeNull()

      view.setInitialText('盘上草稿')

      await waitFor(() => {
        expect(editor?.textContent ?? '').toContain('盘上草稿')
      })
    } finally {
      harnessed.unmount()
    }
  })

  test('人已经写了：晚到的盘上草稿不覆盖', async () => {
    const harnessed = await harness()

    try {
      const view = harnessed.renderComposer(() => undefined)
      const editor = view.container.querySelector<HTMLElement>('[data-slot="prompt-input-editor"]')
      expect(editor).not.toBeNull()

      view.handle()?.setText('手写这一句')
      await waitFor(() => {
        expect(editor?.textContent ?? '').toContain('手写这一句')
      })

      view.setInitialText('盘上草稿')
      expect(editor?.textContent ?? '').toContain('手写这一句')
      expect(editor?.textContent ?? '').not.toContain('盘上草稿')
    } finally {
      harnessed.unmount()
    }
  })
})

/*
 * 入口页没有对话号，但屏幕上的那一格同样是正文。它也必须登记在在屏表里，
 * 否则 ConversationUiToken.activeComposer 只能写进 store，编辑器里看不到（Q50 的入口页那一半）。
 */
describe('入口页在屏输入框', () => {
  test('登记到在屏表：往 activeComposer 插字真的进编辑器', async () => {
    const harnessed = await harness()

    try {
      const view = harnessed.renderComposer(() => undefined)
      const editor = view.container.querySelector<HTMLElement>('[data-slot="prompt-input-editor"]')
      expect(editor).not.toBeNull()

      const live = harnessed.liveComposers.get(NEW_THREAD_KEY)
      expect(live).toBeDefined()
      expect(live?.threadId).toBeNull()
      live?.insertText('从插件插进来的一句')

      await waitFor(() => {
        expect(editor?.textContent ?? '').toContain('从插件插进来的一句')
      })
    } finally {
      harnessed.unmount()
    }
  })
})
