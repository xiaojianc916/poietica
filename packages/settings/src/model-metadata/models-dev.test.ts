import { describe, expect, it } from 'bun:test'
import { modelConfigPatch } from './models-dev'

const registry = {
  providers: {
    tokenrouter: {
      id: 'tokenrouter',
      models: {
        'z-ai/glm-5.3-free': {
          id: 'z-ai/glm-5.3-free',
          name: 'GLM 5.3 (free)',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
          tool_call: true,
          limit: { context: 1_000_000, output: 131_072 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      },
    },
  },
  models: {},
}

const provider = { id: 'tokenrouter', providerType: 'openai' }

describe('models.dev metadata projection', () => {
  it('hydrates an exact provider/model alias with declared reasoning efforts', () => {
    expect(
      modelConfigPatch(
        {
          providers: [provider],
          models: [
            {
              provider: 'tokenrouter',
              model: 'tokenrouter/z-ai/glm-5.3-free',
              displayName: null,
              maxContextSize: 128_000,
              capabilities: null,
              maxOutputSize: null,
              supportEfforts: null,
            },
          ],
        },
        registry,
      ),
    ).toEqual({
      'tokenrouter/z-ai/glm-5.3-free': {
        displayName: 'GLM 5.3 (free)',
        maxContextSize: 1_000_000,
        maxOutputSize: 131_072,
        capabilities: ['image_in', 'always_thinking', 'tool_use'],
        supportEfforts: ['low', 'high', 'max'],
      },
    })
  })

  it('does not write when the agent already has the same metadata', () => {
    expect(
      modelConfigPatch(
        {
          providers: [provider],
          models: [
            {
              provider: 'tokenrouter',
              model: 'tokenrouter/z-ai/glm-5.3-free',
              displayName: 'GLM 5.3 (free)',
              maxContextSize: 1_000_000,
              capabilities: ['image_in', 'always_thinking', 'tool_use'],
              maxOutputSize: 131_072,
              supportEfforts: ['low', 'high', 'max'],
            },
          ],
        },
        registry,
      ),
    ).toEqual({})
  })
})
