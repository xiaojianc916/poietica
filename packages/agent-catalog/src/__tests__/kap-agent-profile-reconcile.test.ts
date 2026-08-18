import { describe, expect, it } from 'vitest'
import {
  type AgentProfile,
  builtinKapAgentProfiles,
  reconcileKapAgentProfiles,
} from '../agent-profile'
import { agentById } from '../agents'

/*
 * agents.json 是名单的一份物化，不是第二个来源。
 *
 * 物化把磁盘上那几条与封闭名单对齐，而「对齐」对两类格子是两种意思。
 *
 * 归用户的三格（cwd、env、defaultConfigOptions）原样保留：那是他自己填的。
 * 归名单的四格（command、homeVar、ownHomeDirectory、install）无条件盖回：原生侧
 * 的 agent_program、home_var_of、own_home_of、agent_install_spec 就是从磁盘上这
 * 四格读的，它们必须在，但它们不是用户的东西。
 *
 * 「拷贝停在旧版本」那一类故障因此仍然不存在 —— 不是因为那几格不落盘，而是因为
 * 每次读都盖一遍。手改 agents.json 换掉 command，活不过下一次启动。
 */

const builtins = builtinKapAgentProfiles()
const first = builtins[0]

if (!first) {
  throw new Error('名单里一家 agent 都没有，这份测试没有可用的装置')
}

/* 手写进配置文件的、不在名单里的一家。 */
const homemade: AgentProfile = {
  id: 'homemade',
  cwd: undefined,
  env: {},
  defaultConfigOptions: {},
}

describe('内置档案的物化', () => {
  it('磁盘为空时给出全部内置档案', () => {
    const result = reconcileKapAgentProfiles([])

    expect(result.changed).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.profiles.map((profile) => profile.id)).toEqual(builtins.map((one) => one.id))
  })

  it('与名单一致时不报改动', () => {
    const result = reconcileKapAgentProfiles(builtins)

    expect(result.changed).toBe(false)
    expect(result.issues).toEqual([])
    expect(result.profiles).toEqual(builtins)
  })

  it('用户自己那三格原样保留', () => {
    const mine = { ...first, cwd: '/work', env: { EXTRA: '1' }, defaultConfigOptions: { a: true } }

    const result = reconcileKapAgentProfiles([mine])
    const profile = result.profiles[0]

    expect(profile?.cwd).toBe('/work')
    expect(profile?.defaultConfigOptions).toEqual({ a: true })

    /*
     * env 是唯一两边共用的一格：用户写的留着，名单声明的启动变量合进去。
     * 期望值从描述符现算，不写死 —— 写死等于让这条测试认准某一家 agent。
     *
     * 这里不断言 changed：它取决于这一家有没有声明启动变量，而那不是这条
     * 测试要说的事。手写值会不会被盖，由下面那条单独说。
     */
    expect(profile?.env).toEqual({
      EXTRA: '1',
      ...(agentById(first.id)?.launchEnv ?? {}),
    })
  })

  /*
   * 这四格在磁盘上，但它不是一个可写的入口。
   *
   * agents.json 是一个能用文本编辑器改的文件，而 command 会被交给
   * resolve_program 去起一个进程 —— 上一版把这四格从档案里删掉，正是为了堵住
   * 「渲染层报一个程序路径过来」那条任意命令执行的路。堵住它的办法现在不是
   * 「档案里没有这一格」，而是「这一格每次都被名单盖掉」，加上原生侧
   * validate_program 仍然独立把关。
   */
  it('手写的 command 活不过一次对齐', () => {
    const result = reconcileKapAgentProfiles([{ ...first, command: 'evil' }])
    const profile = result.profiles[0]

    expect(result.changed).toBe(true)
    expect(profile?.command).toBe(agentById(first.id)?.command)
  })

  /*
   * 名单是封闭的，所以一条不在名单里的档案是用不了的：原生侧按 id 查不到该起哪个
   * 程序。留着它只会让下拉里多一家选中就失败的 agent。丢掉必须说出来。
   */
  it('移除不在名单里的档案，并说明原因', () => {
    const result = reconcileKapAgentProfiles([homemade])

    expect(result.changed).toBe(true)
    expect(result.profiles.some((profile) => profile.id === 'homemade')).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toContain('homemade')
  })

  it('移除之后名单里的那几家仍然补齐', () => {
    const result = reconcileKapAgentProfiles([homemade])

    expect(result.profiles.map((profile) => profile.id)).toEqual(builtins.map((one) => one.id))
  })
})
