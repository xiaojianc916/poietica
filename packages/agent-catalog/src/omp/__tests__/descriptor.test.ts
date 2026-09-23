import { describe, expect, it } from 'bun:test'
import { ohMyPi } from '../descriptor'

describe('omp 的接入档案', () => {
  it('启动的是随包发的边车，不是用户装的东西', () => {
    expect(ohMyPi.command).toBe('poietica-agent')
    expect(ohMyPi.args).toEqual([])
  })

  it('受控 home 走 PI_CODING_AGENT_DIR：绝对 agent 目录，不是 home 下的目录名', () => {
    expect(ohMyPi.homeVar).toBe('PI_CODING_AGENT_DIR')
    expect(ohMyPi.ownHomeDirectory).toBe('.omp')
  })

  it('没有 install 一格：agent 随包发，没有要用户去装的东西', () => {
    expect('install' in ohMyPi).toBe(false)
  })

  it('模块路径按版本重建，避免跨 PowerShell 版本遮蔽', () => {
    expect(ohMyPi.unsetEnv).toEqual(['PSModulePath'])
  })
})
