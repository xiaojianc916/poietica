import { describe, expect, test } from 'bun:test'
import { commandErrorText, commandOutputText, shortTokens } from '../command-output'

/*
 * U-04：omp 内置命令的输出折成给人看的中文。判据是 omp 18.10.3 的原句（builtin-lifecycle / builtin-modes / shake-types）。
 * 已在界面上别处体现的成功结果不推（null）；认得的句子说中文；认不出的原样交回，不吞。
 */
describe('命令输出的中文化', () => {
  test('压缩、交接、改名、换模型成功：结果在时间线 / 标题 / 模型胶囊上，不再推一块输出', () => {
    for (const said of [
      'Compaction complete. Tokens: 39919 -> 23710 (saved 16209).',
      'Compaction complete.',
      'Context handed off and compacted in place.',
      'Session renamed to 修复登录.',
      'Model set to deepseek/deepseek-v4.',
      'Session-only model: deepseek/deepseek-v4.',
    ]) {
      expect(commandOutputText(said)).toBeNull()
    }
  })

  test('失败说中文，认得的原因也译；认不出的原因原样接在后面', () => {
    expect(commandOutputText('Compaction failed: Nothing to compact (session too small)')).toBe(
      '压缩失败：对话还太短，没有可压缩的内容',
    )
    expect(commandOutputText('Compaction failed: Already compacted')).toBe('压缩失败：刚压缩过，没有新的内容可压缩')
    expect(commandOutputText('Handoff failed: Nothing to hand off (no messages yet)')).toBe(
      '交接失败：还没有可交接的对话',
    )
    expect(commandOutputText('Handoff failed: No model selected for handoff')).toBe('交接失败：没有可用的模型')
    expect(commandOutputText('Handoff failed: 429 rate limited')).toBe('交接失败：429 rate limited')
    expect(commandOutputText('Rename failed: disk full')).toBe('重命名失败：disk full')
    expect(commandOutputText('Handoff cancelled.')).toBe('已取消交接')
  })

  test('模型：查看当前、找不到、切换失败', () => {
    expect(commandOutputText('Current model: deepseek/deepseek-v4')).toBe('当前模型：deepseek/deepseek-v4')
    expect(commandOutputText('No model is currently selected.')).toBe('还没有选择模型')
    expect(
      commandOutputText(
        'Unknown model: opux. Use ACP `session/setModel` for picker-driven selection or list available models with /model.',
      ),
    ).toBe('找不到模型「opux」')
    expect(commandOutputText('Unknown model: opux')).toBe('找不到模型「opux」')
    expect(commandOutputText('Failed to switch model: no key')).toBe('切换模型失败：no key')
  })

  test('/shake 的几种结果', () => {
    expect(commandOutputText('Shook 3 tool results + 1 block (~12345 tokens freed).')).toBe(
      '已移除 3 个工具结果、1 段大块内容，释放约 12.3K token',
    )
    expect(commandOutputText('Nothing to shake.')).toBe('没有可清理的大块内容')
    expect(commandOutputText('Dropped 2 images from this session.')).toBe('已移除 2 张图片')
    expect(commandOutputText('Dropped 1 thinking block from this session (~800 tokens freed).')).toBe(
      '已移除 1 段思考内容，释放约 800 token',
    )
  })

  test('认不出的（报表、omp 新加的句子）原样交回；空白不推', () => {
    const report = 'Context window: 200000 tokens (20% used)\n  Messages         ███░░  40000 tokens'
    expect(commandOutputText(report)).toBe(report)
    expect(commandOutputText('Something new from omp.')).toBe('Something new from omp.')
    expect(commandOutputText('   ')).toBeNull()
  })

  test('抛出来的错误：认得的原因说中文，其余原样', () => {
    expect(commandErrorText('Nothing to hand off (already compacted)')).toBe('刚压缩过，没有新的内容可交接')
    expect(commandErrorText('Rename failed: disk full')).toBe('重命名失败：disk full')
    expect(commandErrorText('agent 正忙')).toBe('agent 正忙')
  })

  test('token 短写', () => {
    expect(shortTokens(999)).toBe('999')
    expect(shortTokens(39_919)).toBe('39.9K')
    expect(shortTokens(120_000)).toBe('120K')
    expect(shortTokens(1_250_000)).toBe('1.3M')
  })
})
