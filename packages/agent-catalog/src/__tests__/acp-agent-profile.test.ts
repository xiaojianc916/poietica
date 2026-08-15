import { describe, expect, it } from 'vitest'
import {
  agentLaunch,
  builtinAcpAgentProfileSet,
  parseAcpAgentProfile,
  parseAcpAgentProfileSet,
} from '../agent-profile'
import { agentById, agentRoster } from '../agents'

/* 一份档案里现在只有用户自己的东西。 */
const valid = {
  id: 'kimi',
  env: { NO_COLOR: '1' },
  defaultConfigOptions: { model: 'kimi-k2-turbo-preview', brave_mode: false },
}

describe('parseAcpAgentProfile', () => {
  it('接受一个完整档案', () => {
    const result = parseAcpAgentProfile(valid)

    expect(result.ok).toBe(true)

    if (result.ok) {
      expect(result.profile.env['NO_COLOR']).toBe('1')
      expect(result.profile.defaultConfigOptions['brave_mode']).toBe(false)
    }
  })

  it('拒绝不合法的 agent 标识', () => {
    expect(parseAcpAgentProfile({ ...valid, id: 'NOT AN ID' }).ok).toBe(false)
  })

  it('拒绝不合法的环境变量名', () => {
    expect(parseAcpAgentProfile({ ...valid, env: { 'not-an-env': '1' } }).ok).toBe(false)
  })

  it('拒绝非字符串非布尔的会话配置值', () => {
    expect(parseAcpAgentProfile({ ...valid, defaultConfigOptions: { model: 3 } }).ok).toBe(false)
  })

  /*
   * 回归护栏：「起哪个程序」只能有一个产地 —— 但产地不是靠解析时剥掉来保证的。
   *
   * 原生侧有五个函数从这份档案里读东西：agent_program 读 command，home_var_of 读
   * homeVar，own_home_of 读 ownHomeDirectory，agent_install_spec 读 install，
   * declared_env_of 读 env。上一版把前四格从档案里删了，却没有改那四个函数，于是
   * 它们在结构上变成了死路 —— 屏幕上是「kimi 的接入档案里没有可执行文件」，而受控
   * home 的那个变量从此再没有被设过一次。
   *
   * 所以四格回到了档案里，但它们不属于用户：reconcileAcpAgentProfiles 每次都从
   * 描述符无条件盖回去（见下面那份 reconcile 测试的「手写的 command 活不过一次
   * 对齐」）。解析这一层因此不再负责剥掉它们 —— 一个只在内存里存在半个函数调用
   * 的值，谁都读不到。
   *
   * args 是另一回事：原生侧从不从档案读它，启动参数走 IPC 的 agentLaunch。
   * 它至今不是档案的一格，这一条仍然要守。
   */
  it('磁盘上遗留的 args 不进档案，归描述符的四格恒定在场', () => {
    const result = parseAcpAgentProfile({ ...valid, command: 'evil', args: ['--rm-rf'] })

    expect(result.ok).toBe(true)

    if (result.ok) {
      expect(Object.keys(result.profile).sort()).toEqual([
        'command',
        'cwd',
        'defaultConfigOptions',
        'env',
        'homeVar',
        'id',
        'install',
        'ownHomeDirectory',
      ])

      /* 键面恒定：没写 command 的档案也有这一格，值是 undefined。原生侧读到
      缺席与读到空串是同一个结果，所以这里要的是「结构上一定有这一格」。 */
      expect('args' in result.profile).toBe(false)
    }
  })
})

describe('parseAcpAgentProfileSet', () => {
  it('丢弃坏条目但保留好条目', () => {
    const result = parseAcpAgentProfileSet({
      profiles: [valid, { id: 'BROKEN' }],
      defaultProfileId: 'kimi',
    })

    expect(result.value.profiles).toHaveLength(1)
    expect(result.issues).toHaveLength(1)
  })

  it('默认 agent 指向不存在的档案时回落到第一个', () => {
    const result = parseAcpAgentProfileSet({ profiles: [valid], defaultProfileId: 'ghost' })

    expect(result.value.defaultProfileId).toBe('kimi')
    expect(result.issues).toHaveLength(1)
  })

  it('完全无法解析时回退到内置档案', () => {
    const result = parseAcpAgentProfileSet(null)

    expect(result.value.profiles).toEqual(builtinAcpAgentProfileSet().profiles)
    expect(result.fallback).toBe(true)
  })

  /*
   * 每一台新电脑的第一次启动。磁盘上一条都没有不是配置出了问题，所以一条 issue
   * 都不该有 —— 但 fallback 必须为真，调用方据此把内置档案物化到 agents.json，
   * 否则原生侧按 agentId 去查永远查不到。
   */
  it('磁盘为空时回退且不报问题，但要求物化', () => {
    const result = parseAcpAgentProfileSet({ profiles: [], defaultProfileId: '' })

    expect(result.value.profiles).toEqual(builtinAcpAgentProfileSet().profiles)
    expect(result.issues).toEqual([])
    expect(result.fallback).toBe(true)
  })

  it('档案都在但全都用不了时，照实报问题', () => {
    const result = parseAcpAgentProfileSet({ profiles: [{ id: 'BROKEN' }] })

    expect(result.fallback).toBe(true)
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('磁盘上有可用档案时不要求物化', () => {
    const result = parseAcpAgentProfileSet({ profiles: [valid], defaultProfileId: 'kimi' })

    expect(result.fallback).toBe(false)
  })
})

describe('agentLaunch', () => {
  it('把名单里的一家翻成 agentId 加 program 加 args', () => {
    const agent = agentRoster()[0]

    expect(agentLaunch(agent)).toEqual({
      agentId: agent.id,
      program: agent.command,
      args: [...agent.args],
    })
  })

  /*
   * 回归护栏：参数必须一直是数组，永远不能退回一行字符串。这一条正是旧的
   * 「命令行往返」测试测不出来的东西 —— 它用的是 kimi acp，一个既没有空格
   * 也没有反斜杠的例子，所以那趟往返看起来是无损的。
   */
  it('带空格的绝对路径与反斜杠原样保留', () => {
    const launch = agentLaunch({
      ...agentRoster()[0],
      command: 'C:\\Program Files\\kimi\\kimi.exe',
      args: ['acp', '--cwd', 'C:\\my notes'],
    })

    expect(launch.program).toBe('C:\\Program Files\\kimi\\kimi.exe')
    expect(launch.args).toEqual(['acp', '--cwd', 'C:\\my notes'])
  })
})

describe('builtinAcpAgentProfileSet', () => {
  it('每一条都指向名单里真实存在的一家', () => {
    const set = builtinAcpAgentProfileSet()

    expect(set.profiles.length).toBeGreaterThan(0)

    for (const profile of set.profiles) {
      expect(agentById(profile.id), profile.id).toBeDefined()
    }

    expect(set.profiles.some((profile) => profile.id === set.defaultProfileId)).toBe(true)
  })
})
