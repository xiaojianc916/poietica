import { describe, expect, test } from 'bun:test'
import { createReviewWatcher } from '../watch'

/** 07 页 §10G：watch 两次 unwatch 一次仍在监听，再 unwatch 一次停止。 */

function makeWatcher() {
  const started: string[] = []
  const stopped: string[] = []
  const triggers = new Map<string, () => void>()
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
  })
  return { watcher, started, stopped, triggers }
}

describe('review 监听引用计数', () => {
  test('同一个路径 watch 两次只 start 一次；unwatch 一次仍在监听', () => {
    const { watcher, started, stopped, triggers } = makeWatcher()
    let fired = 0
    watcher.watch('/repo', () => {
      fired += 1
    })
    watcher.watch('/repo', () => {
      fired += 1
    })
    expect(started).toEqual(['/repo'])
    watcher.unwatch('/repo')
    expect(stopped).toEqual([])
    triggers.get('/repo')?.()
    expect(fired).toBe(2)
    watcher.unwatch('/repo')
    expect(stopped).toEqual(['/repo'])
  })

  test('unwatch 未知路径是空操作；dispose 停掉全部', () => {
    const { watcher, started, stopped } = makeWatcher()
    watcher.unwatch('/nope')
    expect(started).toEqual([])
    watcher.watch('/a', () => undefined)
    watcher.watch('/b', () => undefined)
    watcher.dispose()
    expect(stopped.sort()).toEqual(['/a', '/b'])
    /* dispose 之后再 watch 会重新起一次（计数表已清空） */
    watcher.watch('/a', () => undefined)
    expect(started).toEqual(['/a', '/b', '/a'])
  })

  test('两个路径各自通知各自的监听者，互不串扰', () => {
    const { watcher, triggers } = makeWatcher()
    const seen: string[] = []
    watcher.watch('/repo-a', () => {
      seen.push('a')
    })
    watcher.watch('/repo-b', () => {
      seen.push('b')
    })
    triggers.get('/repo-b')?.()
    expect(seen).toEqual(['b'])
    triggers.get('/repo-a')?.()
    expect(seen).toEqual(['b', 'a'])
  })
})
