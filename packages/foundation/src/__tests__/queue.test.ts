import { describe, expect, test } from 'bun:test'
import { delay } from '../async'
import { Mutex, SerialQueue } from '../queue'

describe('SerialQueue', () => {
  test('三个任务按入队顺序完成', async () => {
    const queue = new SerialQueue()
    const order: string[] = []
    const first = queue.run(async () => {
      await delay(20)
      order.push('a')
    })
    const second = queue.run(() => {
      order.push('b')
    })
    const third = queue.run(() => {
      order.push('c')
    })
    await Promise.all([first, second, third])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  test('中间任务抛错不影响后续', async () => {
    const queue = new SerialQueue()
    const order: string[] = []
    const first = queue.run(() => {
      order.push('a')
      throw new Error('boom')
    })
    const second = queue.run(() => {
      order.push('b')
    })
    await expect(first).rejects.toThrow('boom')
    await second
    expect(order).toEqual(['a', 'b'])
  })

  test('size 在执行中为 3、完成后为 0', async () => {
    const queue = new SerialQueue()
    const gate = new DeferredLike()
    const tasks = [queue.run(() => gate.promise), queue.run(() => undefined), queue.run(() => undefined)]
    expect(queue.size).toBe(3)
    gate.release()
    await Promise.all(tasks)
    expect(queue.size).toBe(0)
  })
})

describe('Mutex', () => {
  test('两个 runExclusive 不重叠', async () => {
    const mutex = new Mutex()
    let active = 0
    let maxActive = 0
    const task = async (): Promise<void> => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active--
    }
    await Promise.all([mutex.runExclusive(task), mutex.runExclusive(task)])
    expect(maxActive).toBe(1)
    expect(mutex.locked).toBe(false)
  })

  test('释放函数重复调用无效果', async () => {
    const mutex = new Mutex()
    const release = await mutex.lock()
    release()
    release()
    expect(await mutex.runExclusive(() => 'ok')).toBe('ok')
  })
})

/** 手工可控的 Promise，避免测试依赖具体时长 */
class DeferredLike {
  private resolveFn: (() => void) | undefined
  readonly promise = new Promise<void>((resolve) => {
    this.resolveFn = resolve
  })
  release(): void {
    this.resolveFn?.()
  }
}
