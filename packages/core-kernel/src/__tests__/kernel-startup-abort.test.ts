import { describe, expect, test } from 'bun:test'
import { Deferred } from '@poietica/foundation'
import { defineCoreModule } from '../module'
import { makeKernel } from './helpers'

/*
 * 启动途中被叫停（Host 断开 / core.shutdown 落在 setup、onReady 还没跑完的时候）。
 * 修复前：关停与启动交错执行 —— 关停钩子与 db.close 跑在 onReady 中间，start 随后照样把状态写回 ready；
 * 退出回调在 serve 里是 start 返回之后才挂的，于是 Core 永远不退出（Host 已经死了的话，就是孤儿进程）。
 */
const settle = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

function slowReadyModule(gate: Deferred<void>, ran: string[]) {
  return defineCoreModule({
    id: 'slow',
    setup(ctx) {
      ctx.lifecycle.onReady(async () => {
        ran.push('ready:start')
        await gate.promise
        ran.push('ready:end')
      })
      ctx.lifecycle.onShutdown(() => {
        ran.push('shutdown')
      })
    },
  })
}

function laterModule(ran: string[]) {
  return defineCoreModule({
    id: 'later',
    dependsOn: ['slow'],
    setup(ctx) {
      ctx.lifecycle.onReady(() => {
        ran.push('later:ready')
      })
    },
  })
}

describe('core-kernel 启动途中被叫停', () => {
  test('KA-1 onReady 跑着时 Host 断开：等这一步收手再关停，后面的 onReady 不再跑，也不发 core.ready', async () => {
    const gate = new Deferred<void>()
    const ran: string[] = []
    const h = await makeKernel([slowReadyModule(gate, ran), laterModule(ran)], { start: false })
    const exits: number[] = []
    h.kernel.onExit((code) => exits.push(code))
    const started = h.kernel.start()
    await settle()
    h.closeTransport()
    await settle()
    expect(ran).toEqual(['ready:start'])
    gate.resolve()
    await started
    await settle()
    expect(ran).toEqual(['ready:start', 'ready:end', 'shutdown'])
    expect(h.notifications('core.ready')).toEqual([])
    expect(exits).toEqual([0])
  })

  test('KA-2 关停已经跑完之后才挂的退出回调也会被调用', async () => {
    const h = await makeKernel([], { start: true })
    await h.kernel.shutdown('done')
    const exits: number[] = []
    h.kernel.onExit((code) => exits.push(code))
    await settle(1)
    expect(exits).toEqual([0])
  })

  test('KA-3 启动途中那一步一直不返回：关停最多等预算，照样跑完并退出', async () => {
    const never = new Deferred<void>()
    const ran: string[] = []
    const h = await makeKernel([slowReadyModule(never, ran)], { start: false })
    const exits: number[] = []
    h.kernel.onExit((code) => exits.push(code))
    void h.kernel.start()
    await settle()
    const done = h.kernel.shutdown('stuck')
    await settle()
    h.clock.advance(3_000)
    await done
    expect(ran).toEqual(['ready:start', 'shutdown'])
    expect(exits).toEqual([0])
    expect(h.log.at('warn').some((r) => r.msg === 'startup step did not yield before shutdown')).toBe(true)
  })
})
