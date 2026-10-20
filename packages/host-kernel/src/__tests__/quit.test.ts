import { expect, mock, test } from 'bun:test'
import { DisposableStore } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'

/*
 * quit.ts 顶层 import 了 electron（默认真 app.exit）。bun test 下 electron 包只是
 * 「返回可执行文件路径的字符串」，命名导出不存在 —— 只能在导入前把模块换掉。
 * mock 必须先于动态 import 注册，所以这里不用静态 import。
 */
mock.module('electron', () => ({ app: { exit: () => undefined } }))
const { createQuitCoordinator } = await import('../quit')

/*
 * R-08-11：退出顺序必须是「先停了 Core，再跑 Host 自己的清理」。
 *
 * 从前 Host 钩子（终端 disposeAll、浏览器、偏好 flush）先跑、supervisor.stop() 最后 ——
 * Core 关停期间（会话中止、工具收尾）可能还在调 owner='host' 的方法，那时对应服务已经
 * 释放，只剩一串噪音错误。Host 钩子里没有任何一样需要 Core 活着（都是本地动作）。
 */
test('R-08-11 退出顺序：藏窗口 → supervisor.stop → 收 omp 后台进程 ‖ Host 钩子（倒序）→ disposables（倒序）→ 销毁窗口', async () => {
  const order: string[] = []
  const logger = createTestLogger()
  const stores: DisposableStore[] = []
  const coordinator = createQuitCoordinator({
    logger,
    supervisor: {
      stop: async () => {
        order.push('supervisor.stop')
      },
      reapOrphans: async () => {
        order.push('supervisor.reapOrphans')
      },
    },
    windows: {
      hideAll: () => {
        order.push('windows.hideAll')
      },
      destroyAll: () => {
        order.push('windows.destroyAll')
      },
    },
    exit: () => {
      order.push('exit')
    },
  })
  coordinator.addShutdownHook('terminal', () => {
    order.push('hook:terminal')
  })
  coordinator.addShutdownHook('browser', () => {
    order.push('hook:browser')
  })
  const first = new DisposableStore()
  first.add({ dispose: () => order.push('dispose:first') })
  const second = new DisposableStore()
  second.add({ dispose: () => order.push('dispose:second') })
  stores.push(first, second)
  for (const store of stores) coordinator.addDisposables(store)

  await coordinator.quit('test')

  expect(order).toEqual([
    /* 用户感知的「关掉了」排第一：窗口先藏，再做任何可能耗时的收尾 */
    'windows.hideAll',
    'supervisor.stop',
    /* 收 omp 后台进程与 Host 钩子并发：它先被发起，不等它跑完钩子就开始了 */
    'supervisor.reapOrphans',
    /* 钩子与 disposables 都倒序：后注册的先收，与依赖的建立顺序相反 */
    'hook:browser',
    'hook:terminal',
    'dispose:second',
    'dispose:first',
    'windows.destroyAll',
    'exit',
  ])
})

test('R-08-11 quit 只跑一次；钩子抛错只记 warn，不拦住后面的清理', async () => {
  const order: string[] = []
  const logger = createTestLogger()
  const coordinator = createQuitCoordinator({
    logger,
    supervisor: {
      stop: async () => {
        order.push('supervisor.stop')
      },
      reapOrphans: async () => {
        order.push('supervisor.reapOrphans')
      },
    },
    windows: { hideAll: () => order.push('windows.hideAll'), destroyAll: () => order.push('windows.destroyAll') },
    exit: () => order.push('exit'),
  })
  coordinator.addShutdownHook('bad', () => {
    order.push('hook:bad')
    throw new Error('钩子炸了')
  })

  await Promise.all([coordinator.quit('first'), coordinator.quit('second')])

  expect(order).toEqual([
    'windows.hideAll',
    'supervisor.stop',
    'supervisor.reapOrphans',
    'hook:bad',
    'windows.destroyAll',
    'exit',
  ])
  expect(logger.at('warn').map((r) => r.msg)).toContain('onShutdown hook failed')
})

test('退出时窗口在 Core 停下之前就已经藏起来（用户点关闭不再等好几秒）', async () => {
  const order: string[] = []
  let releaseCore!: () => void
  const coreStopped = new Promise<void>((resolve) => {
    releaseCore = resolve
  })
  const coordinator = createQuitCoordinator({
    logger: createTestLogger(),
    supervisor: {
      stop: async () => {
        order.push('supervisor.stop:begin')
        await coreStopped
        order.push('supervisor.stop:end')
      },
      reapOrphans: async () => undefined,
    },
    windows: { hideAll: () => order.push('windows.hideAll'), destroyAll: () => order.push('windows.destroyAll') },
    exit: () => order.push('exit'),
  })

  const quitting = coordinator.quit('test')
  /* Core 还在关停（会话逐条释放），窗口已经不在屏幕上了 */
  expect(order).toEqual(['windows.hideAll', 'supervisor.stop:begin'])
  releaseCore()
  await quitting
  expect(order).toEqual([
    'windows.hideAll',
    'supervisor.stop:begin',
    'supervisor.stop:end',
    'windows.destroyAll',
    'exit',
  ])
})

test('收 omp 后台进程与 Host 钩子并发：慢的枚举不再串在钩子前面', async () => {
  const order: string[] = []
  let releaseReap!: () => void
  const reapDone = new Promise<void>((resolve) => {
    releaseReap = resolve
  })
  const coordinator = createQuitCoordinator({
    logger: createTestLogger(),
    supervisor: {
      stop: async () => undefined,
      reapOrphans: async () => {
        order.push('reap:begin')
        await reapDone
        order.push('reap:end')
      },
    },
    windows: { hideAll: () => undefined, destroyAll: () => order.push('windows.destroyAll') },
    exit: () => order.push('exit'),
  })
  coordinator.addShutdownHook('preferences', () => {
    order.push('hook:preferences')
  })

  const quitting = coordinator.quit('test')
  await new Promise((r) => setTimeout(r, 0))
  /* 枚举还没回来，钩子已经跑完；窗口要等两者都结束才销毁 */
  expect(order).toEqual(['reap:begin', 'hook:preferences'])
  releaseReap()
  await quitting
  expect(order).toEqual(['reap:begin', 'hook:preferences', 'reap:end', 'windows.destroyAll', 'exit'])
})

test('退出途中又启动一次 → 收尾后 relaunch；未在退出时请求无效；走 finalize（更新安装）时不 relaunch', async () => {
  const order: string[] = []
  const deps = {
    logger: createTestLogger(),
    supervisor: { stop: async () => undefined, reapOrphans: async () => undefined },
    windows: { hideAll: () => undefined, destroyAll: () => undefined },
    exit: () => order.push('exit'),
    relaunch: () => order.push('relaunch'),
  }

  const idle = createQuitCoordinator(deps)
  idle.requestRelaunch()
  await idle.quit('test')
  expect(order).toEqual(['exit'])

  order.length = 0
  const second = createQuitCoordinator(deps)
  const quitting = second.quit('test')
  second.requestRelaunch()
  await quitting
  expect(order).toEqual(['relaunch', 'exit'])

  order.length = 0
  const updating = createQuitCoordinator(deps)
  const installing = updating.quit('update', { finalize: () => order.push('finalize') })
  updating.requestRelaunch()
  await installing
  expect(order).toEqual(['finalize'])
})
