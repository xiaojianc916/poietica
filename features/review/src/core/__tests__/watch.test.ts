import { describe, expect, test } from 'bun:test'
import { createReviewWatcher } from '../watch'

function makeWatcher() {
  const started: string[] = []
  const stopped: string[] = []
  const triggers = new Map<string, () => void>()
  const changed: string[] = []
  const watcher = createReviewWatcher({
    start: (path, onChange) => {
      started.push(path)
      triggers.set(path, onChange)
      return {
        dispose: () => {
          stopped.push(path)
          triggers.delete(path)
        },
      }
    },
    onChange: (workspaceId) => {
      changed.push(workspaceId)
    },
  })
  return { watcher, started, stopped, triggers, changed }
}

describe('review 监听：按工作区计数', () => {
  test('同一个工作区 watch 两次只 start 一次；unwatch 一次仍在监听，两次才停', () => {
    const { watcher, started, stopped, triggers, changed } = makeWatcher()
    watcher.watch('w1', '/repo')
    watcher.watch('w1', '/repo')
    expect(started).toEqual(['/repo'])
    watcher.unwatch('w1')
    expect(stopped).toEqual([])
    triggers.get('/repo')?.()
    expect(changed).toEqual(['w1'])
    watcher.unwatch('w1')
    expect(stopped).toEqual(['/repo'])
  })

  test('来回 watch / unwatch 之后，一次改动仍只通知一次（旧实现会攒下重复的回调）', () => {
    const { watcher, triggers, changed } = makeWatcher()
    watcher.watch('w1', '/repo')
    for (let round = 0; round < 3; round += 1) {
      watcher.watch('w1', '/repo')
      watcher.unwatch('w1')
    }
    triggers.get('/repo')?.()
    expect(changed).toEqual(['w1'])
  })

  test('forget 不论计数立即停；之后的 unwatch 是空操作', () => {
    const { watcher, stopped } = makeWatcher()
    watcher.watch('w1', '/repo')
    watcher.watch('w1', '/repo')
    watcher.forget('w1')
    expect(stopped).toEqual(['/repo'])
    watcher.unwatch('w1')
    watcher.unwatch('w1')
    expect(stopped).toEqual(['/repo'])
  })

  test('同一个工作区换了目录：旧目录停掉、新目录接上，计数沿用', () => {
    const { watcher, started, stopped } = makeWatcher()
    watcher.watch('w1', '/old')
    watcher.watch('w1', '/new')
    expect(started).toEqual(['/old', '/new'])
    expect(stopped).toEqual(['/old'])
    watcher.unwatch('w1')
    expect(stopped).toEqual(['/old'])
    watcher.unwatch('w1')
    expect(stopped).toEqual(['/old', '/new'])
  })

  test('unwatch 未知工作区是空操作；dispose 停掉全部，之后还能重新 watch', () => {
    const { watcher, started, stopped } = makeWatcher()
    watcher.unwatch('nope')
    expect(started).toEqual([])
    watcher.watch('a', '/a')
    watcher.watch('b', '/b')
    watcher.dispose()
    expect(stopped.sort()).toEqual(['/a', '/b'])
    watcher.watch('a', '/a')
    expect(started).toEqual(['/a', '/b', '/a'])
  })

  test('两个工作区各报各的', () => {
    const { watcher, triggers, changed } = makeWatcher()
    watcher.watch('a', '/repo-a')
    watcher.watch('b', '/repo-b')
    triggers.get('/repo-b')?.()
    triggers.get('/repo-a')?.()
    expect(changed).toEqual(['b', 'a'])
  })
})
