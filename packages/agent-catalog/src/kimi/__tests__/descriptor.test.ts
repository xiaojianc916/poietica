import { describe, expect, it } from 'bun:test'
import { kimiCode } from '../descriptor'

describe('kimi 的接入档案', () => {
  /*
   * 接的是 kap 本地服务模式：web 子命令起 server，--no-open 不开浏览器。
   * 谁想退回 acp 入口，先过这一条。
   */
  it('起的是本地服务模式', () => {
    expect(kimiCode.args).toEqual(['web', '--no-open'])
  })

  /* 受控 home 是模式 B 的地基：这个变量名错了，provider 与密钥就写去了别的目录。 */
  it('受控 home 认 KIMI_CODE_HOME', () => {
    expect(kimiCode.homeVar).toBe('KIMI_CODE_HOME')
    expect(kimiCode.ownHomeDirectory).toBe('.kimi-code')
  })
})
