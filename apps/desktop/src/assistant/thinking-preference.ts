import type { SessionConfigControl } from '@poietica/conversation'
import { createPreference, type Preference, type PreferenceFailure } from '@poietica/external-store'
import { z } from 'zod'

type ThinkingValues = Readonly<Record<string, string>>
type ThinkingStorage = Pick<Preference<ThinkingValues>, 'read' | 'write'>

/* 存的是「模型 → 档位」这张表；非空字符串值之外一律丢弃，与 controls-memory 同一个形状。 */
const ThinkingValuesSchema = z.record(z.string(), z.string().min(1))

interface PreferredThinking {
  readonly control: SessionConfigControl
  readonly value: string
}

export interface ThinkingPreference {
  readonly selection: (
    agentId: string,
    controls: readonly SessionConfigControl[],
  ) => PreferredThinking | undefined
  readonly remember: (
    agentId: string,
    controls: readonly SessionConfigControl[],
    controlId: string,
    value: string,
  ) => void
}

function storageKey(agentId: string, model: string): string {
  return JSON.stringify([agentId, model])
}

function decodeValues(raw: string): ThinkingValues {
  return ThinkingValuesSchema.parse(JSON.parse(raw))
}

function modelOf(controls: readonly SessionConfigControl[]): string | undefined {
  return controls.find((control) => control.purpose === 'model')?.current
}

export function createThinkingPreferenceFromStorage(stored: ThinkingStorage): ThinkingPreference {
  return {
    selection(agentId, controls) {
      const model = modelOf(controls)
      const control = controls.find((candidate) => candidate.purpose === 'thought')

      if (model === undefined || control === undefined) {
        return undefined
      }

      const value = stored.read()[storageKey(agentId, model)]

      return value !== undefined && control.choices.some((choice) => choice.value === value)
        ? { control, value }
        : undefined
    },

    remember(agentId, controls, controlId, value) {
      const model = modelOf(controls)
      const control = controls.find((candidate) => candidate.id === controlId)

      if (
        model === undefined ||
        control?.purpose !== 'thought' ||
        control.current !== value ||
        !control.choices.some((choice) => choice.value === value)
      ) {
        return
      }

      const key = storageKey(agentId, model)
      const current = stored.read()

      if (current[key] !== value) {
        stored.write({ ...current, [key]: value })
      }
    },
  }
}

export function createThinkingPreference(
  onFailure: (failure: PreferenceFailure) => void,
): ThinkingPreference {
  const stored = createPreference<ThinkingValues>({
    key: 'poietica.thinking-by-model',
    fallback: {},
    decode: decodeValues,
    encode: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
    onFailure,
  })

  return createThinkingPreferenceFromStorage(stored)
}
