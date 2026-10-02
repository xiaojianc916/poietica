import { describe, expect, it } from 'bun:test'
import { ohMyPi } from '../descriptor'

describe('omp 的接入档案', () => {
  it('启动的是随包发的运行时加随包发的桥，不是用户装的东西', () => {
    expect(ohMyPi.command).toBe('bun')
    expect(ohMyPi.entry).toBe('poietica-bridge.js')
    expect(ohMyPi.args).toEqual([])
  })

  it('受控 home 走 PI_CODING_AGENT_DIR：绝对 agent 目录，不是 home 下的目录名', () => {
    expect(ohMyPi.homeVar).toBe('PI_CODING_AGENT_DIR')
    expect(ohMyPi.ownHomeDirectory).toBe('.omp')
  })

  it('模块路径按版本重建，避免跨 PowerShell 版本遮蔽', () => {
    expect(ohMyPi.unsetEnv).toContain('PSModulePath')
  })

  /*
   * 我们不是编译出来的二进制，而 SDK 与 pi-natives 都按这个变量判「编译态」：
   * 它一为真，候选表就把用户目录排到随包那份前面，SDK 的 CLI 入口也会在进程里跑起来。
   * 它读的是运行时环境，所以必须在这里摘掉。
   */
  it('摘掉 PI_COMPILED：编译态会让用户目录盖过随包的原生模块', () => {
    expect(ohMyPi.unsetEnv).toContain('PI_COMPILED')
  })
})
