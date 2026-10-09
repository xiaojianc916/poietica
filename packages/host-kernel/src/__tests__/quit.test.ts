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
test('R-08-11 退出顺序：supervisor.stop → Host 钩子（倒序）→ disposables（倒序）→ 销毁窗口', async () => {
  const order: string[] = []
  const logger = createTestLogger()
  const stores: DisposableStore[] = []
  const coordinator = createQuitCoordinator({
    logger,
    supervisor: {
      stop: async () => {
        order.push('supervisor.stop')
      },
    },
    windows: {
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
    'supervisor.stop',
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
    },
    windows: { destroyAll: () => order.push('windows.destroyAll') },
    exit: () => order.push('exit'),
  })
  coordinator.addShutdownHook('bad', () => {
    order.push('hook:bad')
    throw new Error('钩子炸了')
  })

  await Promise.all([coordinator.quit('first'), coordinator.quit('second')])

  expect(order).toEqual(['supervisor.stop', 'hook:bad', 'windows.destroyAll', 'exit'])
  expect(logger.at('warn').map((r) => r.msg)).toContain('onShutdown hook failed')
})
