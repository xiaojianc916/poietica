import { describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, defineUiFeature, KernelProvider } from '@poietica/ui-kernel'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { type ReactNode, useRef } from 'react'
import { composerToolkitSources } from '../../ui-api'
import { ComposerActions, composerPaletteGroups } from '../components/composer/composer-actions'
import { ComposerDraftsContext } from '../components/composer/drafts-context'
import {
  PromptInput,
  PromptInputBody,
  PromptInputEditor,
  type PromptInputHandle,
  PromptInputToolbar,
} from '../components/composer/prompt-input'
import { ComposerDrafts } from '../composer/drafts'
import type { PromptInputMessage } from '../composer/prompt'

/*
 * 从面板行到提交的那条线：点「技能」那一行 → 正文里落一枚记号 → 发送时
 * `PromptInputMessage.skills` 里带着这个名字（`turns.submit.skills` 收的就是它）。
 *
 * 这一条之前是断的：面板里的行由贡献点给的数据画出来（见 composer-toolkit.test.ts），
 * 而行画不出来时后面的路一步都走不到 —— 这个用例把「画出来之后真的能用」钉死。
 */

/*
 * 动效在这里按住：面板开合是 motion 的两段动画（见 primitives/motion），而 happy-dom 的
 * `Element.animate` 不推进时间轴 —— 动画停在中途被取消时，motion reject 一个没人接的
 * `finished` promise（`AbortError: The animation was canceled.`），一条这样的 rejection
 * 就足以判整个用例失败。真机上不会发生。
 *
 * 用 `MotionConfig skipAnimations` 而不是去改系统偏好：后者在 motion 内部**首次读取时
 * 就缓存**（useReducedMotion 的惰性初始化），同一个测试进程里再改已经晚了，而且把时长
 * 压到 0 也仍然会建一条动画、仍然会被取消。MotionConfig 是逐子树的配置，动的就是这条
 * 面板自己，动画整条不建。
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

/** 装一台空内核（只用它的贡献点注册表与 Context，不走任何 RPC 数据）。 */
async function harness(): Promise<{
  readonly renderComposer: (onSubmit: (message: PromptInputMessage) => void) => {
    readonly container: HTMLElement
    readonly handle: () => PromptInputHandle | null
  }
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
  const containers: HTMLElement[] = []

  return {
    renderComposer: (onSubmit) => {
      let handle: PromptInputHandle | null = null

      function Composer(): ReactNode {
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
                <PromptInput
                  groups={groups}
                  onSubmit={onSubmit}
                  ref={(next) => {
                    ref.current = next
                    handle = next
                  }}
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
      containers.push(container)

      return { container, handle: () => handle }
    },
    unmount: () => {
      cleanup()
      containers.length = 0
    },
  }
}

describe('从加号面板到提交', () => {
  test('技能那一行落进正文，发送时 skills 里带着它的名字', async () => {
    const closed: PromptInputMessage[] = []
    const harnessed = await harness()

    try {
      const { container, handle } = harnessed.renderComposer((message) => {
        closed.push(message)
      })

      /* 先把一句话写进正文：技能记号本身不满足提交条件（与 legacy 同一条判据）。 */
      handle()?.setText('帮我翻一下')

      /* 翻开面板：先写正文再点，正文里那一句不该被吞掉（toggleRow 的 run 入参就是它）。 */
      const plus = container.querySelector<HTMLButtonElement>('button[aria-label="添加内容"]')
      expect(plus).not.toBeNull()
      fireEvent.click(plus!)

      /* 技能那一行。 */
      await waitFor(() => {
        expect(container.textContent ?? '').toContain('翻译')
      })
      const row = [...container.querySelectorAll<HTMLButtonElement>('.composer-palette__row')].find((button) =>
        button.textContent?.includes('翻译'),
      )
      expect(row).not.toBeUndefined()
      fireEvent.mouseDown(row!)

      /* 记号是经 Lexical 的 update 插进去的：那一次更新在微任务里落地。 */
      await waitFor(() => {
        expect(container.querySelector('.assistant-prompt-chip')).not.toBeNull()
      })

      /* 提交。 */
      const form = container.querySelector('form')
      expect(form).not.toBeNull()
      fireEvent.submit(form!)

      expect(closed).toHaveLength(1)
      expect(closed[0]?.text).toContain('帮我翻一下')
      expect(closed[0]?.skills).toEqual([{ name: '翻译' }])
    } finally {
      /* 等面板的退场动画走完再拆：happy-dom 里半途取消会抛 AbortError（真机不会）。 */
      await Bun.sleep(400)
      harnessed.unmount()
    }
  })
})
