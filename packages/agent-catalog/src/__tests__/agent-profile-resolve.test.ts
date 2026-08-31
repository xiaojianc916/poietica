import { describe, expect, it } from 'bun:test'
import { parseAgentProfile, resolveAgentProfile } from '../agent-profile'
import { kimiCode } from '../kimi/descriptor'

/*
 * agents.json 是 kimiCode 描述符的一份物化，不是第二个来源。
 *
 * 用户那几格原样保留；原生侧要读的那几格每次无条件盖回 —— 它读的是磁盘，而名单在
 * 这个进程里。
 */
const stored = {
  id: kimiCode.id,
  env: {},
  defaultConfigOptions: {},
  command: kimiCode.command,
  args: [...kimiCode.args],
  homeVar: kimiCode.homeVar,
  ownHomeDirectory: kimiCode.ownHomeDirectory,
  install: {
    packageName: kimiCode.install.packageName,
    versionArgs: [...kimiCode.install.versionArgs],
  },
}

describe('resolveAgentProfile', () => {
  it('磁盘为空时给出内置档案，并要求物化', () => {
    const resolved = resolveAgentProfile([])

    expect(resolved.profile.id).toBe(kimiCode.id)
    expect(resolved.materialize).toBe(true)
    expect(resolved.issues).toEqual([])
  })

  it('与描述符一致时不写盘', () => {
    const resolved = resolveAgentProfile([stored])

    expect(resolved.materialize).toBe(false)
    expect(resolved.issues).toEqual([])
  })

  it('用户自己那几格原样保留', () => {
    const resolved = resolveAgentProfile([
      { ...stored, cwd: '/work', env: { EXTRA: '1' }, defaultConfigOptions: { brave_mode: true } },
    ])

    expect(resolved.profile.cwd).toBe('/work')
    expect(resolved.profile.env).toEqual({ EXTRA: '1' })
    expect(resolved.profile.defaultConfigOptions).toEqual({ brave_mode: true })
  })

  it('手写进磁盘的启动命令活不过一次解析', () => {
    const resolved = resolveAgentProfile([{ ...stored, command: 'rm' }])

    expect(resolved.profile.command).toBe(kimiCode.command)
    expect(resolved.materialize).toBe(true)
  })

  it('别家 agent 的档案被移除，并说出原因', () => {
    const resolved = resolveAgentProfile([
      stored,
      { id: 'homemade', env: {}, defaultConfigOptions: {} },
    ])

    expect(resolved.profile.id).toBe(kimiCode.id)
    expect(resolved.materialize).toBe(true)
    expect(resolved.issues).toHaveLength(1)
  })

  it('档案被改坏时照常可用，但不写回磁盘', () => {
    const resolved = resolveAgentProfile([{ ...stored, env: { 'not-an-env': '1' } }])

    expect(resolved.materialize).toBe(false)
    expect(resolved.issues).toHaveLength(1)
    expect(resolved.profile.command).toBe(kimiCode.command)
  })

  it('物化出去的那一份自己能过校验，且原生侧要读的格子齐全', () => {
    const materialized = resolveAgentProfile([]).profile

    expect(parseAgentProfile(materialized).ok).toBe(true)
    expect(Object.keys(materialized).sort()).toEqual([
      'args',
      'command',
      'cwd',
      'defaultConfigOptions',
      'env',
      'homeVar',
      'id',
      'install',
      'ownHomeDirectory',
    ])
  })
})
