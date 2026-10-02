import { describe, expect, it, mock } from 'bun:test'

/*
 * 外链必须走 preload 装的 host 桥，不能走 invoke。
 *
 * 这条钉的是一次真实故障：`openBrowserUrlExternally` 发的是
 * invoke('window_open_external_url')，而**原生命令面上没有这个名字** ——
 * apps/desktop/native/src/ipc/mod.rs 的 `submit` 以 `unknown =>` 收尾，会把它结算成
 * NotFound。症状是「链接看得见、点了什么都不发生」，且失败只落在控制台里。
 *
 * 判据因此不是「调没调用」，而是「调用落在哪条通道上」：命令面与宿主面是两条路，
 * 名字长得像不代表走得通。这里把两条路都记下来，断言走的是宿主那条。
 *
 * 自检跑法：bun test src/__tests__/external-link-uses-the-host-bridge.test.ts
 */

const openExternal = mock((url: string): Promise<void> => {
  void url
  return Promise.resolve()
})

const invoke = mock((command: string, args: unknown): Promise<unknown> => {
  void command
  void args
  return Promise.resolve(null)
})

/* 桩只装在 window.poietica 这一层：hostBridge() 读的就是它。
 *
 * 不另写 declare global —— 仓库已经有一份生成的 `Window.poietica` 声明，再补一份
 * 就是两个事实。这一层要的只是「运行时那个对象在」，形状由 host-bridge.ts 自己的
 * 断言负责。 */
const bridge = {
  invoke,
  on: () => () => undefined,
  host: { openExternal },
}

/* 测试进程没有 DOM：defineProperty 的 value 不参与窗口类型校验，正好只装这一格。 */
Object.defineProperty(globalThis, 'window', { value: { poietica: bridge }, configurable: true })

const { openBrowserUrlExternally } = await import('../browser')

describe('外链通路', () => {
  it('走宿主桥，不走原生命令面', async () => {
    invoke.mockClear()
    openExternal.mockClear()

    await openBrowserUrlExternally('https://example.com/')

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal.mock.calls[0]?.[0]).toBe('https://example.com/')
    /* invoke 那条路上没有这条命令：一次都不该发。 */
    expect(invoke).toHaveBeenCalledTimes(0)
  })

  it('地址原样交给宿主，不在这一层改写', async () => {
    invoke.mockClear()
    openExternal.mockClear()

    const url = 'https://github.com/xiaojianc916/poietica?tab=readme#top'

    await openBrowserUrlExternally(url)

    expect(openExternal.mock.calls[0]?.[0]).toBe(url)
  })
})
