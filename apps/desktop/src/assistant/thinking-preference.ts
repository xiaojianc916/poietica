import type { SessionConfigControl } from '@poietica/conversation'
import { createPreference, type Preference, type PreferenceFailure } from '@poietica/external-store'

type ThinkingValues = Readonly<Record<string, string>>
type ThinkingStorage = Pick<Preference<ThinkingValues>, 'read' | 'write'>

interface PreferredThinking {
  readonly control: SessionConfigControl
  readonly value: string
}

interface ThinkingPreference {
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
  const parsed: unknown = JSON.parse(raw)

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Thinking preference must be a JSON object.')
  }

  const values: Record<string, string> = {}

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Thinking preference values must be non-empty strings.')
    }

    values[key] = value
  }

  return values
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
