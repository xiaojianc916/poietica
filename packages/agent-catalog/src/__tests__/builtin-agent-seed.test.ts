import { describe, expect, it } from 'bun:test'
import { builtinAgentProfileSet, parseAgentProfile } from '../agent-profile'
import { agentById } from '../agents'

/*
 * 内置档案不再只是一个内存里的回退值：首次启动时它会被原样写进 agents.json。
 *
 * 所以它必须能过自己那道校验。一条过不了 parseAgentProfile 的内置档案，会
 * 在落盘之后每次读回来都被丢掉，界面表现为「配置好了，模型列表却是空的」。
 *
 * 「要起哪个程序」不再问这份档案 —— 那件事从磁盘上搬走了，问名单。
 */
describe('内置 agent 档案', () => {
  it('至少有一条，且每条都能过自己的校验', () => {
    const set = builtinAgentProfileSet()

    expect(set.profiles.length).toBeGreaterThan(0)

    for (const profile of set.profiles) {
      expect(parseAgentProfile(profile).ok, profile.id).toBe(true)
    }
  })

  it('默认档案指向名单里的一条', () => {
    const set = builtinAgentProfileSet()

    expect(set.profiles.some((profile) => profile.id === set.defaultProfileId)).toBe(true)
  })

  /* 档案必须写清起哪个程序：起的是用户自己装的那个 CLI（见 agent-descriptor.ts
  的 command 说明）。 */
  it('每条都能在名单里查到要起哪个程序', () => {
    for (const profile of builtinAgentProfileSet().profiles) {
      const descriptor = agentById(profile.id)

      expect(descriptor?.command?.length ?? 0, profile.id).toBeGreaterThan(0)
    }
  })

  /*
   * 原生侧从档案里读的那四格必须在，而且必须与名单一致。
   *
   * 「不许出现」是上一版的规矩，它换来的是四条死路（见 kap-agent-profile.test.ts
   * 里那段）。现在的规矩是「必须在，但不归用户」：写进 agents.json 的值只能是名单
   * 投影下来的那一份，所以手改那个文件改不动启动身份，而原生侧读得到东西。
   */
  it('档案里带齐原生侧要读的那几格', () => {
    for (const profile of builtinAgentProfileSet().profiles) {
      expect(Object.keys(profile).sort(), profile.id).toEqual([
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
    }
  })

  /*
   * 投影必须逐字，不能只是「有值」。
   *
   * 差一个字符的 command 就是一个起不来的 agent，而它起不来的地方在原生侧，
   * 报出来的话与用户刚做的任何动作都对不上号。
   */
  it('档案里的启动身份逐字来自名单', () => {
    for (const profile of builtinAgentProfileSet().profiles) {
      const agent = agentById(profile.id)

      expect(agent, profile.id).toBeDefined()

      if (!agent) {
        continue
      }

      expect(profile.command, profile.id).toBe(agent.command)
      expect(profile.homeVar, profile.id).toBe(agent.homeVar)
      expect(profile.ownHomeDirectory, profile.id).toBe(agent.ownHomeDirectory)
    }
  })
})
