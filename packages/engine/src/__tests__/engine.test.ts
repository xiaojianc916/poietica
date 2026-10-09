import { describe, expect, test } from 'bun:test'
import { EngineErrorCode, engineErrorMessages } from '../errors'
import { Interaction, InteractionAnswer, ModelRef, Posture } from '../values'

describe('engine 端口', () => {
  test('engineErrorMessages 覆盖每个错误码', () => {
    expect(Object.keys(engineErrorMessages).sort()).toEqual([...Object.values(EngineErrorCode)].sort())
  })

  test('Posture.options 为三档', () => {
    expect(Posture.options).toEqual(['ask', 'auto-edit', 'full-access'])
  })

  test('ModelRef 拒绝空的 provider', () => {
    expect(ModelRef.safeParse({ provider: '', id: 'x' }).success).toBe(false)
    expect(ModelRef.safeParse({ provider: 'anthropic', id: 'x' }).success).toBe(true)
  })

  test('Interaction 每种 kind 的合法样例都能解析', () => {
    const samples = [
      {
        kind: 'approval',
        id: 'i1',
        createdAt: 1,
        timeoutAt: null,
        tool: 'bash',
        title: '运行命令',
        detail: 'rm -rf',
        allowSessionScope: true,
      },
      {
        kind: 'question',
        id: 'i2',
        createdAt: 1,
        timeoutAt: 100,
        questions: [
          {
            id: 'q1',
            prompt: '选一个',
            multiple: false,
            allowCustom: true,
            options: [{ id: 'o1', label: '甲', description: null }],
          },
        ],
      },
      { kind: 'select', id: 'i3', createdAt: 1, timeoutAt: null, title: '选择', options: ['a', 'b'] },
      { kind: 'input', id: 'i4', createdAt: 1, timeoutAt: null, title: '输入', placeholder: null, multiline: true },
      { kind: 'confirm', id: 'i5', createdAt: 1, timeoutAt: null, title: '确认', message: '继续？' },
      {
        kind: 'plan',
        id: 'i6',
        createdAt: 1,
        timeoutAt: null,
        title: '计划',
        planFilePath: 'local://x-plan.md',
        planMarkdown: '# 计划',
      },
    ]
    for (const sample of samples) {
      const parsed = Interaction.safeParse(sample)
      expect(parsed.success).toBe(true)
    }
  })

  test('InteractionAnswer 每种 kind 的合法样例都能解析', () => {
    const samples = [
      { kind: 'approval', decision: 'approve', scope: 'once', feedback: null },
      { kind: 'question', answers: { q1: { selected: ['o1'], custom: null } } },
      { kind: 'select', value: 'a' },
      { kind: 'input', value: 'text' },
      { kind: 'confirm', value: true },
      { kind: 'plan', decision: 'revise', feedback: '再想想' },
      { kind: 'dismiss' },
    ]
    for (const sample of samples) {
      expect(InteractionAnswer.safeParse(sample).success).toBe(true)
    }
  })
})
