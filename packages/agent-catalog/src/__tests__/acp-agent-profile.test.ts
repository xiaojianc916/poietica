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
   * 原生侧从这份档案里读：agent_program 读 command，agent_args 读 args，
   * home_var_of 读 homeVar，own_home_of 读 ownHomeDirectory，agent_install_spec
   * 读 install，declared_env_of 读 env。上一版把前四格从档案里删了，却没有改
   * 那些函数，于是它们在结构上变成了死路 —— 屏幕上是「kimi 的接入档案里没有
   * 可执行文件」，而受控 home 的那个变量从此再没有被设过一次。
   *
   * 所以这几格回到了档案里，但它们不属于用户：reconcileAcpAgentProfiles 每次
   * 都从描述符无条件盖回去（见下面那份 reconcile 测试的「手写的 command 活不过
   * 一次对齐」）。解析这一层因此不再负责剥掉它们 —— 一个只在内存里存在半个函数
   * 调用的值，谁都读不到。args 与 command 同一条规矩：原生侧的 agent_args 读它，
   * 磁盘上带什么就进什么。
   */
  it('磁盘上的 args 与描述符那几格一起恒定在场', () => {
    const result = parseAcpAgentProfile({
      ...valid,
      command: 'kimi',
      args: ['acp', '--cwd', 'C:\\my notes'],
    })

    expect(result.ok).toBe(true)

    if (result.ok) {
      expect(Object.keys(result.profile).sort()).toEqual([
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
      expect(result.profile.args).toEqual(['acp', '--cwd', 'C:\\my notes'])
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
  it('把名单里的一家翻成线上那两格', () => {
    const agent = agentRoster()[0]

    expect(agentLaunch(agent)).toEqual({
      agentId: agent.id,
      transport: agent.transport,
    })
  })

  /*
   * 回归护栏：传输是档案声明的，这一层原样交出。
   *
   * 漏掉这一条的后果已经发生过：deepseek-harness 的档案写着自己那条线，而线上
   * 形状只有三格，于是原生侧无从选择，起的是官方 bin、说的是 ACP，握手必失败。
   */
  it('传输原样交出，不在这一层改写', () => {
    for (const agent of agentRoster()) {
      expect(agentLaunch(agent).transport, agent.id).toBe(agent.transport)
    }
  })

  /*
   * 回归护栏：启动规格不再携带程序与参数。
   *
   * 程序在哪、要几个参数，是「这台机器上」的事实：acp 线要在搜索路径上解析一个
   * 用户自己装的 CLI，harness 线要问已安装的运行时包。渲染进程两样都答不出
   * （agent-profile.ts 的 agentLaunch 注释），所以这一层交出的只有身份与传输，
   * 其余由原生侧按 agentId 从档案读。
   */
  it('程序与参数不进启动规格，那是原生侧的事', () => {
    const launch = agentLaunch({
      ...agentRoster()[0],
      command: 'C:\\Program Files\\kimi\\kimi.exe',
      args: ['acp', '--cwd', 'C:\\my notes'],
    })

    expect(launch).toEqual({ agentId: launch.agentId, transport: launch.transport })
    expect('program' in launch).toBe(false)
    expect('args' in launch).toBe(false)
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
