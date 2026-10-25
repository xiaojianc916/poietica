import { describe, expect, test } from 'bun:test'
import { commandErrorOf, commandOutputOf, shortTokens } from '../command-output'

/* 大多数用例只看译文；色调另有一组用例 */
const commandOutputText = (raw: string): string | null => commandOutputOf(raw)?.text ?? null
const commandErrorText = (message: string): string => commandErrorOf(message).text

/*
 * U-04：omp 内置命令的输出折成给人看的中文。判据是 omp 18.12.6 的原句（builtin-lifecycle / builtin-modes / shake-types）。
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
      'Retrying the last failed turn.',
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
    expect(commandOutputText('Could not generate a session title. Use /rename <title> to set one.')).toBe(
      '没能自动生成标题',
    )
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

  test('色调：成功、提示、警告、错误由认得原句的这一层定，屏幕不拿译文猜', () => {
    expect(commandOutputOf('Fast mode enabled.')).toEqual({ text: '已开启快速模式', tone: 'success' })
    expect(commandOutputOf('Fast mode is unavailable for the current model.')).toEqual({
      text: '当前模型不支持快速模式',
      tone: 'warning',
    })
    expect(commandOutputOf('Fast mode is ultra.')).toEqual({ text: '快速模式：极速', tone: 'info' })
    expect(commandOutputOf('Slow mode is off (auto).')).toEqual({ text: '慢速模式：关', tone: 'info' })
    expect(commandOutputOf('Nothing to retry.')).toEqual({ text: '没有可重试的失败回复', tone: 'warning' })
    expect(commandOutputOf('Fresh provider session started (2 provider states pruned).')).toEqual({
      text: '已重置与服务商的连接（清掉 2 份连接状态）',
      tone: 'success',
    })
    expect(commandOutputOf('Could not generate a session title. Use /rename <title> to set one.')).toEqual({
      text: '没能自动生成标题',
      tone: 'warning',
    })
    expect(commandOutputOf('Usage: /slow [on|off|status]')).toEqual({
      text: '参数不对，用法：/slow [on|off|status]',
      tone: 'warning',
    })
    expect(commandOutputOf('Compaction failed: Already compacted')?.tone).toBe('error')
    expect(commandOutputOf('Shook 3 tool results (~100 tokens freed).')?.tone).toBe('success')
    expect(commandOutputOf('Nothing to shake.')?.tone).toBe('info')
    expect(commandOutputOf('Something new from omp.')?.tone).toBe('info')
    expect(commandErrorOf('agent 正忙')).toEqual({ text: 'agent 正忙', tone: 'error' })
  })

  test('token 短写', () => {
    expect(shortTokens(999)).toBe('999')
    expect(shortTokens(39_919)).toBe('39.9K')
    expect(shortTokens(120_000)).toBe('120K')
    expect(shortTokens(1_250_000)).toBe('1.3M')
  })
})
