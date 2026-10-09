import { describe, expect, test } from 'bun:test'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import { createFakeEngine } from '@poietica/engine-testkit'
import { pythonContract } from '../../contract'
import python from '../index'

/*
 * 模块级的 onReady 行为（07 页 §13C 的 onReady 一行）：
 * 没有安装（标记文件不在）→ absent；且**不碰**对别的解释器路径的设置。
 *
 * 规则本身（标记不符 + 解释器指向我们目录 → 清空）在 release.test.ts 的 onReadyPlan 里逐条钉住；
 * 这里验的是它确实被按这条规则接进了模块的启动路径。
 */

describe('python core onReady', () => {
  test('首次启动（什么都没装）→ python.status 报 absent，且不改动解释器设置', async () => {
    const engine = createFakeEngine()
    // 用户自己配了系统 Python：不是我们管的路径，谁都不许动它
    await engine.settings.setPythonInterpreter('C:\\Python312\\python.exe')
    const before = engine.pythonInterpreterCalls.length

    const h = await createCoreHarness({ modules: [python], engine })
    const api = h.client(pythonContract)

    const status = await api.call('python.status', {})
    expect(status.state).toBe('absent')
    expect(status.version).toBeNull()
    expect(status.error).toBeNull()
    // onReady 只读了设置，没有写
    expect(engine.pythonInterpreterCalls.length).toBe(before)

    await h.dispose()
  })

  test('启动时的 onReady 会把状态推给订阅者（python.statusChanged 至少一条）', async () => {
    const h = await createCoreHarness({ modules: [python], engine: createFakeEngine() })
    const changes = h.notifications(pythonContract, 'python.statusChanged')
    // 首次启动必然走过一次 absent（harness 启动时 onReady 已执行）
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.at(-1)?.state).toBe('absent')
    await h.dispose()
  })
})

/*
 * 端到端的安装闭环（PY-1 / PY-4）：把全局 fetch 换成可控的假实现，模块里的
 * install 就会走真实编排 —— 下载、校验、解压（真跑 System32\tar.exe）、验证
 * （真跑解压出来的 python.exe）、写设置。测试用真 tar 造一个「长得像」的包：
 * 里面放一个 python/python.exe 吧，验证会失败（版本号报不出来）……
 *
 * 所以这里只跑到**下载 + 校验 + 解压**：解压之后验证必然失败（假包不是真 CPython），
 * 那只说明「我们没能造出真的 CPython」；要验的是它与设置的关系由 PY-1 的注入式
 * 用例覆盖。本文件只钉两件与模块接线有关的事：下载中的 remove → busy；重复 install
 * 不第二次下载。
 */
describe('python core 安装状态机（接在模块上）', () => {
  test('PY-4：下载中 python.remove → python.busy', async () => {
    const realFetch = globalThis.fetch
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = (async () => {
      await gate
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } })
    }) as unknown as typeof fetch

    const h = await createCoreHarness({ modules: [python], engine: createFakeEngine() })
    const api = h.client(pythonContract)
    try {
      const installing = api.call('python.install', {})
      await Bun.sleep(5)
      const error = await api.call('python.remove', {}).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as { code?: string }).code).toBe('python.busy')
      release?.()
      await installing
    } finally {
      globalThis.fetch = realFetch
      await h.dispose()
    }
  })

  test('下载拿不到（两个地址都连不上）→ 状态 failed，码是 download_failed，且不写解释器设置', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch

    const engine = createFakeEngine()
    const h = await createCoreHarness({ modules: [python], engine })
    const api = h.client(pythonContract)
    try {
      const status = await api.call('python.install', {})
      expect(status.state).toBe('failed')
      expect(status.error?.code).toBe('python.download_failed')
      /*
       * 只有走到 ready 才允许写 `python.interpreter`；失败的一次不许把设置指到一个
       * 不存在的 exe 上（那会让 omp 的 Python 工具整体失效）。
       */
      expect(engine.pythonInterpreterCalls.length).toBe(0)
    } finally {
      globalThis.fetch = realFetch
      await h.dispose()
    }
  })
})
