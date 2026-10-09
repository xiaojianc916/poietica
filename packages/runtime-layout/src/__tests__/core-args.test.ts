import { describe, expect, test } from 'bun:test'
import { CoreArgsError, parseCoreArgs } from '../core-args'

const EXE = 'C:\\Program Files\\Poietica\\resources\\core\\poietica-core.exe'
/** argv[0] 是可执行文件、argv[1] 是入口（bun 编译版为内嵌入口路径），模式在 argv[2]（08 页 §2.2） */
const ENTRY = 'C:\\Poietica\\apps\\core\\src\\main.ts'
const COMPLETE = [EXE, ENTRY, 'serve', '--data-root', 'C:\\data', '--log-level', 'info', '--relay-port', '4321']
const PROBE = { probeBuild: true }
const RELEASE = { probeBuild: false }

describe('parseCoreArgs', () => {
  // RL-4：完整参数
  test('RL-4 完整参数', () => {
    expect(parseCoreArgs(COMPLETE, PROBE)).toEqual({
      mode: 'serve',
      dataRoot: 'C:\\data',
      logLevel: 'info',
      relayPort: 4321,
      strict: false,
      probeMockModel: false,
    })
  })

  test('RL-4 缺 --relay-port 抛错', () => {
    expect(() => parseCoreArgs([EXE, ENTRY, 'serve', '--data-root', 'C:\\data', '--log-level', 'info'], PROBE)).toThrow(
      CoreArgsError,
    )
  })

  test('RL-4 端口 0 抛错', () => {
    expect(() =>
      parseCoreArgs(
        [EXE, ENTRY, 'serve', '--data-root', 'C:\\data', '--log-level', 'info', '--relay-port', '0'],
        PROBE,
      ),
    ).toThrow('缺少或无效的 --relay-port')
  })

  test('RL-4 未知参数 --foo 抛错', () => {
    expect(() => parseCoreArgs([...COMPLETE, '--foo'], PROBE)).toThrow('未知参数：--foo')
  })

  test('RL-4 重复参数抛错', () => {
    expect(() => parseCoreArgs([...COMPLETE, '--data-root', 'C:\\other'], PROBE)).toThrow('参数重复：--data-root')
  })

  test('RL-4 --strict 位置任意', () => {
    expect(
      parseCoreArgs(
        [EXE, ENTRY, 'serve', '--strict', '--data-root', 'C:\\data', '--log-level', 'info', '--relay-port', '4321'],
        PROBE,
      ).strict,
    ).toBe(true)
    expect(parseCoreArgs([...COMPLETE, '--strict'], PROBE).strict).toBe(true)
  })

  test('RL-4 --probe-mock-model 在正式版抛错、探针版接受', () => {
    expect(() => parseCoreArgs([...COMPLETE, '--probe-mock-model'], RELEASE)).toThrow(CoreArgsError)
    expect(parseCoreArgs([...COMPLETE, '--probe-mock-model'], PROBE).probeMockModel).toBe(true)
  })

  test('RL-4 非 serve 模式抛错', () => {
    expect(() => parseCoreArgs([EXE, ENTRY, 'probe'], PROBE)).toThrow('未知模式：probe')
  })
})
