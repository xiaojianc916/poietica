import { afterEach, describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, defineUiFeature, KernelProvider } from '@poietica/ui-kernel'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Thread } from '../../../../contract'
import { threadActions } from '../../../../ui-api'
import { ThreadTitleMenu } from '../thread-title-menu'

/*
 * 会话页左上角那一格（机器图标 + 标题 + 下拉箭头）。
 *
 * 两件事必须是判据：标题**跟着 prop 换**（omp 总结出新标题、用户改名都走这一条），
 * 菜单里是那几项内置动作 + 其它功能贡献的动作（automations 的定时任务）；
 * 标题与下拉箭头是**两枚各管各的按钮**（产品负责人 2026-10-12 定稿）。
 */

function testBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send(message) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener({ jsonrpc: '2.0', id, result: { state: 'ready', reason: null, attempt: 0 } })
          }
        })
      }
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pathForFile: () => 'C:/tmp/x',
  } satisfies WindowBridge
}

function threadOf(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    workspaceId: 'w1',
    title: '新对话',
    titleSource: 'pending',
    posture: 'auto-edit',
    origin: 'user',
    state: 'idle',
    hasSession: false,
    forkedFrom: null,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

async function mount(
  node: ReactNode,
  contribute = false,
): Promise<{ readonly rerender: (next: ReactNode) => Promise<void> }> {
  const provider = defineUiFeature({
    id: 'test-provider',
    setup: (ctx) => {
      if (contribute) {
        ctx.contribute(threadActions, {
          id: 'test.schedule',
          order: 30,
          title: '以此对话创建定时任务',
          run: () => undefined,
        })
      }
    },
  })
  const kernel = createUiKernel({
    features: [provider],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'conversation.thread', params: { threadId: 't1' } },
    bridge: testBridge(),
  })
  await kernel.start()
  const mounted = await act(async () => render(<KernelProvider kernel={kernel}>{node}</KernelProvider>))
  return {
    rerender: async (next) => {
      await act(async () => {
        mounted.rerender(<KernelProvider kernel={kernel}>{next}</KernelProvider>)
      })
    },
  }
}

afterEach(() => {
  cleanup()
})

describe('会话页左上角标题菜单', () => {
  test('标题跟着 prop 换：omp 总结出的新标题上来就换字', async () => {
    const { rerender } = await mount(<ThreadTitleMenu thread={threadOf()} />)

    expect(screen.getByText('新对话')).toBeDefined()
    /*
     * 省略号只认块级盒，标题文字必须装在 .conversation-title__text 里：直接挂在按钮
     * （flex 容器）上会被硬裁断。这条断言钉住那一层壳的存在。
     */
    expect(screen.getByText('新对话').className).toBe('conversation-title__text')

    await rerender(<ThreadTitleMenu thread={threadOf({ title: '按思考动画设计重构代码', titleSource: 'auto' })} />)

    expect(screen.getByText('按思考动画设计重构代码')).toBeDefined()
    expect(screen.queryByText('新对话')).toBeNull()
  })

  test('菜单是固定 / 重命名 / 导出会话，之后接贡献的动作', async () => {
    await mount(
      <ThreadTitleMenu
        onExport={() => undefined}
        onPin={() => undefined}
        onRename={() => undefined}
        thread={threadOf()}
      />,
      true,
    )

    await act(async () => {
      fireEvent.click(screen.getByLabelText('对话操作'))
    })

    expect(screen.getByText('固定')).toBeDefined()
    expect(screen.getByText('重命名')).toBeDefined()
    expect(screen.getByText('导出会话')).toBeDefined()
    expect(screen.getByText('以此对话创建定时任务')).toBeDefined()
  })

  test('点重命名换成就地输入框，提交时交回新标题', async () => {
    const renamed: string[] = []
    await mount(
      <ThreadTitleMenu
        onRename={(_id, title) => {
          renamed.push(title)
        }}
        thread={threadOf({ title: '旧标题' })}
      />,
    )

    /* 标题本体是改名入口：点一下直接进就地编辑，不开菜单。 */
    await act(async () => {
      fireEvent.click(screen.getByText('旧标题'))
    })

    const field = screen.getByLabelText('重命名对话')
    fireEvent.change(field, { target: { value: '新标题' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)

    expect(renamed).toEqual(['新标题'])
  })

  test('菜单里的重命名也进就地编辑', async () => {
    const renamed: string[] = []
    await mount(
      <ThreadTitleMenu
        onRename={(_id, title) => {
          renamed.push(title)
        }}
        thread={threadOf({ title: '旧标题' })}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByLabelText('对话操作'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('重命名'))
    })

    /*
     * 菜单里点「重命名」等弹层关闭动画走完再进编辑（Base UI 的关闭完成通知）。
     * happy-dom 里这条通知要靠真实计时器推。
     */
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    })

    const field = screen.getByLabelText('重命名对话')
    fireEvent.change(field, { target: { value: '菜单改的名' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)

    expect(renamed).toEqual(['菜单改的名'])
  })
})
