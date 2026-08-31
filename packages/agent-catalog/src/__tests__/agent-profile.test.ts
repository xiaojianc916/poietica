import { describe, expect, it } from 'bun:test'
import { parseAgentProfile } from '../agent-profile'

const valid = {
  id: 'kimi',
  env: { NO_COLOR: '1' },
  defaultConfigOptions: { model: 'kimi-k2-turbo-preview', brave_mode: false },
}

describe('parseAgentProfile', () => {
  it('接受一份只有用户那几格的档案', () => {
    const parsed = parseAgentProfile(valid)

    expect(parsed.ok).toBe(true)
  })

  it('接受 Windows 风格的工作目录', () => {
    const parsed = parseAgentProfile({ ...valid, cwd: 'C:\\my notes' })

    expect(parsed.ok).toBe(true)
  })

  it('拒绝不合法的 agent 标识', () => {
    const parsed = parseAgentProfile({ ...valid, id: 'Kimi Code' })

    expect(parsed.ok).toBe(false)
  })

  it('拒绝不合法的环境变量名', () => {
    const parsed = parseAgentProfile({ ...valid, env: { 'no-color': '1' } })

    expect(parsed.ok).toBe(false)
  })

  it('拒绝既不是字符串也不是布尔的会话配置值', () => {
    const parsed = parseAgentProfile({ ...valid, defaultConfigOptions: { model: 3 } })

    expect(parsed.ok).toBe(false)
  })

  it('拒绝不是对象的东西', () => {
    expect(parseAgentProfile(null).ok).toBe(false)
    expect(parseAgentProfile('kimi').ok).toBe(false)
  })
})
