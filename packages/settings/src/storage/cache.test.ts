import { expect, test } from 'bun:test'
import { createStorageMeasurement } from './cache'
import type { StorageReport } from './port'

function report(measuredAt: number, totalBytes = 100): StorageReport {
  return { entries: [], measuredAt, scannedFiles: 0, totalBytes, truncated: false }
}

test('保鲜期内不再数第二遍，过期了才数', async () => {
  let calls = 0
  let clock = 1_000

  const measurement = createStorageMeasurement(
    () => {
      calls += 1

      return Promise.resolve(report(clock, calls * 100))
    },
    { freshMs: 2 * 60 * 60 * 1000, now: () => clock },
  )

  const first = await measurement.read()

  expect(calls).toBe(1)
  expect(first.totalBytes).toBe(100)

  /* 半小时后再进这一页：还是那一份。 */
  clock += 30 * 60 * 1000
  expect((await measurement.read()).totalBytes).toBe(100)
  expect(calls).toBe(1)

  /* 过了两小时：重新数。 */
  clock += 2 * 60 * 60 * 1000
  expect((await measurement.read()).totalBytes).toBe(200)
  expect(calls).toBe(2)
})

test('手动测量不问新旧；并发只走一趟', async () => {
  let calls = 0
  const measurement = createStorageMeasurement(() => {
    calls += 1

    return Promise.resolve(report(Date.now()))
  })

  await measurement.read()
  await measurement.force()
  expect(calls).toBe(2)

  const [a, b] = await Promise.all([measurement.force(), measurement.force()])

  expect(calls).toBe(3)
  expect(a).toBe(b)
})

test('清完顺手回的那一份直接生效，不再问一遍', async () => {
  let calls = 0
  const measurement = createStorageMeasurement(() => {
    calls += 1

    return Promise.resolve(report(Date.now(), 999))
  })

  measurement.accept(report(Date.now(), 7))

  expect((await measurement.read()).totalBytes).toBe(7)
  expect(calls).toBe(0)
})

test('量失败不留半份缓存，下一次读再试', async () => {
  let calls = 0
  const measurement = createStorageMeasurement(() => {
    calls += 1

    return calls === 1
      ? Promise.reject(new Error('数不动'))
      : Promise.resolve(report(Date.now(), 5))
  })

  await expect(measurement.read()).rejects.toThrow('数不动')
  expect((await measurement.read()).totalBytes).toBe(5)
  expect(calls).toBe(2)
})
