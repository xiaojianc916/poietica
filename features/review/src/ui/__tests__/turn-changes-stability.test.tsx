import { afterEach, describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import { render, waitFor } from '@testing-library/react'
import {
  createTurnChangesHolder,
  type TurnChangesGateway,
  TurnChangesSource,
  type TurnRewindPreview,
} from '../turn-changes-source'

/*
 * 稳定性：Provider 交出去的那份 api 与 holder 的缓存都不能因为**父组件重渲**而抖。
 *
 * 这条是真机缺陷的回归测试：发新消息时时间线每帧重渲，而 onFailure 是调用点写的内联箭头 ——
 * 它一换身份，rewind → api → subscribe 跟着换，useSyncExternalStore 就退订重订；holder 又在
 * 最后一个看客退订时把缓存删掉，于是重订的那一瞬间 changesOf 交回空表，上一轮那条改动条整条
 * 消失再出现（屏幕上就是闪一下）。
 */

afterEach(() => {
  document.body.innerHTML = ''
})

const ROWS = [
  {
    turn: 1,
    fileCount: 1,
    added: 3,
    removed: 1,
    reverted: false,
    files: [{ path: 'a.ts', added: 3, removed: 1 }],
  },
]

const SAFE: TurnRewindPreview = { safe: [{ path: 'a.ts' }], unsafe: [], canApply: true }

function fakeGateway(): TurnChangesGateway & { readonly listCalls: () => number } {
  let list = 0
  return {
    list: () => {
      list += 1
      return Promise.resolve(ROWS)
    },
    listCalls: () => list,
    preview: () => Promise.resolve(SAFE),
    apply: () => Promise.resolve(),
    onChanged: () => ({ dispose: () => undefined }),
    onThreadRemoved: () => ({ dispose: () => undefined }),
  }
}

/** 每次重渲都换一个 onFailure 身份 —— 调用点就是这么写的（内联箭头）。 */
function Source({
  gateway,
  holder,
  tick,
}: {
  gateway: TurnChangesGateway
  holder: ReturnType<typeof createTurnChangesHolder>
  tick: number
}) {
  const seen: number[] = []
  return (
    <TurnChangesSource
      gateway={gateway}
      holder={holder}
      onFailure={() => {
        seen.push(tick)
      }}
    >
      <span />
    </TurnChangesSource>
  )
}

describe('Provider 的身份稳定性', () => {
  test('父组件重渲（onFailure 换身份）不会让 api 换身份、也不会重读', async () => {
    const gateway = fakeGateway()
    const holder = createTurnChangesHolder({ gateway, logger: createTestLogger() })
    const off = holder.subscribe('t1', () => undefined)
    await waitFor(() => {
      expect(holder.changesOf('t1')).toHaveLength(1)
    })
    const before = holder.changesOf('t1')

    const view = render(<Source gateway={gateway} holder={holder} tick={0} />)
    view.rerender(<Source gateway={gateway} holder={holder} tick={1} />)
    view.rerender(<Source gateway={gateway} holder={holder} tick={2} />)

    /* 缓存同一份引用：重渲期间 changesOf 从没交回过空表，那一格就不会消失再出现。 */
    expect(holder.changesOf('t1')).toBe(before)
    expect(gateway.listCalls()).toBe(1)

    off()
    view.unmount()
  })

  test('最后一个看客退订后重新订阅：缓存还在，不闪成空表', async () => {
    const gateway = fakeGateway()
    const holder = createTurnChangesHolder({ gateway, logger: createTestLogger() })

    const first = holder.subscribe('t1', () => undefined)
    await waitFor(() => {
      expect(holder.changesOf('t1')).toHaveLength(1)
    })

    first()
    /* 退订不该把账本扔掉：它只是「这一格暂时没人看」，不是「这条对话没改过」。 */
    expect(holder.changesOf('t1')).toHaveLength(1)

    const second = holder.subscribe('t1', () => undefined)
    expect(holder.changesOf('t1')).toHaveLength(1)
    second()
  })
})
