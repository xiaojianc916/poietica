import { describe, expect, test } from 'bun:test'
import { createWatchSet, isWatchedPath } from '../watch'

describe('isWatchedPath', () => {
  test('.git 与 node_modules 里的变化不报（Windows 分隔符也认）', () => {
    expect(isWatchedPath('src/a.ts')).toBe(true)
    expect(isWatchedPath('.gitignore')).toBe(true)
    expect(isWatchedPath('.git')).toBe(false)
    expect(isWatchedPath('.git/index')).toBe(false)
    expect(isWatchedPath('node_modules/x/index.js')).toBe(false)
    expect(isWatchedPath('packages\\a\\node_modules\\x.js')).toBe(false)
  })
})

describe('createWatchSet：声明式的监听集合', () => {
  function make() {
    const started: string[] = []
    const stopped: string[] = []
    const triggers = new Map<string, (paths: readonly string[] | null) => void>()
    const changes: [string, string, readonly string[] | null][] = []
    const set = createWatchSet({
      start: (root, onChange) => {
        started.push(root)
        triggers.set(root, onChange)
        return {
          dispose: () => {
            stopped.push(root)
          },
        }
      },
      onChange: (workspaceId, root, paths) => {
        changes.push([workspaceId, root, paths])
      },
    })
    return { set, started, stopped, triggers, changes }
  }

  test('重发同一个全集是空操作（Core 重启后界面重发天然幂等）', () => {
    const { set, started } = make()
    set.set(new Map([['w1', '/a']]))
    set.set(new Map([['w1', '/a']]))
    expect(started).toEqual(['/a'])
  })

  test('补齐差额、停掉多余的；同一个工作区换了根就换一份', () => {
    const { set, started, stopped } = make()
    set.set(
      new Map([
        ['w1', '/a'],
        ['w2', '/b'],
      ]),
    )
    set.set(
      new Map([
        ['w2', '/b2'],
        ['w3', '/c'],
      ]),
    )
    expect(started).toEqual(['/a', '/b', '/b2', '/c'])
    expect(stopped.sort()).toEqual(['/a', '/b'])
    set.set(new Map())
    expect(stopped.sort()).toEqual(['/a', '/b', '/b2', '/c'])
  })

  test('变化带上工作区与根交出去；forget 与 dispose 停掉', () => {
    const { set, triggers, changes, stopped } = make()
    set.set(
      new Map([
        ['w1', '/a'],
        ['w2', '/b'],
      ]),
    )
    triggers.get('/a')?.(['src/x.ts'])
    triggers.get('/b')?.(null)
    expect(changes).toEqual([
      ['w1', '/a', ['src/x.ts']],
      ['w2', '/b', null],
    ])
    set.forget('w1')
    expect(stopped).toEqual(['/a'])
    set.dispose()
    expect(stopped).toEqual(['/a', '/b'])
  })
})
