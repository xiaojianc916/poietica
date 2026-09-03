import snapshot from './models-dev.catalog.json'

interface ProviderLike {
  readonly id: string
  readonly providerType: string
}

interface ModelLike {
  readonly provider: string
  readonly model: string
  readonly displayName: string | null
  readonly maxContextSize: number
  readonly capabilities: readonly string[] | null
  readonly maxOutputSize: number | null
  readonly supportEfforts: readonly string[] | null
}

interface CatalogLike {
  readonly providers: readonly ProviderLike[]
  readonly models: readonly ModelLike[]
}

type UnknownRecord = Record<string, unknown>

const CAPABILITY_ORDER = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'always_thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function catalogFrom(value: unknown): UnknownRecord {
  const root = record(value)
  const catalog = record(root?.['catalog']) ?? root
  if (
    catalog === undefined ||
    record(catalog['providers']) === undefined ||
    record(catalog['models']) === undefined
  ) {
    throw new Error('Bundled models.dev catalog is invalid')
  }
  return catalog
}

const bundledCatalog = catalogFrom(snapshot)

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sortedCapabilities(values: Iterable<string>): string[] {
  const order = new Map<string, number>(
    CAPABILITY_ORDER.map((value, index) => [value, index] as const),
  )
  return [...new Set(values)].sort((left, right) => {
    const leftRank = order.get(left) ?? CAPABILITY_ORDER.length
    const rightRank = order.get(right) ?? CAPABILITY_ORDER.length
    return leftRank - rightRank || left.localeCompare(right)
  })
}

function thinkingOptions(model: UnknownRecord): {
  readonly efforts: readonly string[]
  readonly hasOff: boolean
  readonly hasToggle: boolean
} {
  const efforts: string[] = []
  let hasOff = false
  let hasToggle = false
  const options = model['reasoning_options']
  if (!Array.isArray(options)) {
    return { efforts, hasOff, hasToggle }
  }
  for (const raw of options) {
    const option = record(raw)
    if (option?.['type'] === 'toggle') {
      hasToggle = true
      continue
    }
    if (option?.['type'] !== 'effort' || !Array.isArray(option['values'])) {
      continue
    }
    for (const value of option['values']) {
      if (value === null || (typeof value === 'string' && value.toLowerCase() === 'none')) {
        hasOff = true
      } else if (typeof value === 'string' && value.length > 0 && !efforts.includes(value)) {
        efforts.push(value)
      }
    }
  }
  return { efforts, hasOff, hasToggle }
}

function configuredModel(catalog: UnknownRecord, providerId: string, alias: string) {
  const providers = record(catalog['providers'])
  const provider = record(providers?.[providerId])
  const models = record(provider?.['models'])
  const prefix = `${providerId}/`
  const modelId = alias.startsWith(prefix) ? alias.slice(prefix.length) : alias
  return record(models?.[modelId])
}

export function modelConfigPatch(
  data: CatalogLike,
  source: unknown = bundledCatalog,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const catalog = catalogFrom(source)
  const providerTypes = new Map(
    data.providers.map((provider) => [provider.id, provider.providerType]),
  )
  const result: Record<string, Record<string, unknown>> = {}

  for (const current of data.models) {
    const model = configuredModel(catalog, current.provider, current.model)
    if (model === undefined) {
      continue
    }
    const patch: Record<string, unknown> = {}
    const rawName = model['name']
    const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : undefined
    const limit = record(model['limit'])
    const context = positiveInteger(limit?.['context'])
    const output = positiveInteger(limit?.['output'])
    const modalities = record(model['modalities'])
    const rawInputs = modalities?.['input']
    const inputs = Array.isArray(rawInputs) ? rawInputs : []
    const thinking = thinkingOptions(model)
    const supportsThinking =
      model['reasoning'] === true || thinking.hasToggle || thinking.efforts.length > 0
    const wire = providerTypes.get(current.provider)
    const alwaysThinking =
      supportsThinking &&
      thinking.efforts.length > 0 &&
      !thinking.hasToggle &&
      !thinking.hasOff &&
      wire !== 'anthropic' &&
      wire !== 'kimi'

    if (name !== undefined && name !== current.displayName) {
      patch['displayName'] = name
    }
    if (context !== undefined && context !== current.maxContextSize) {
      patch['maxContextSize'] = context
    }
    if (output !== undefined && output !== current.maxOutputSize) {
      patch['maxOutputSize'] = output
    }

    const capabilities = new Set(current.capabilities ?? [])
    if (inputs.includes('image')) {
      capabilities.add('image_in')
    }
    if (inputs.includes('video')) {
      capabilities.add('video_in')
    }
    if (inputs.includes('audio')) {
      capabilities.add('audio_in')
    }
    if (model['tool_call'] === true) {
      capabilities.add('tool_use')
    }
    if (model['dynamically_loaded_tools'] === true) {
      capabilities.add('dynamically_loaded_tools')
    }
    if (alwaysThinking) {
      capabilities.delete('thinking')
      capabilities.add('always_thinking')
    } else if (supportsThinking && !capabilities.has('always_thinking')) {
      capabilities.add('thinking')
    }
    const nextCapabilities = sortedCapabilities(capabilities)
    const currentCapabilities = sortedCapabilities(current.capabilities ?? [])
    if (!sameValues(nextCapabilities, currentCapabilities)) {
      patch['capabilities'] = nextCapabilities
    }

    if (
      thinking.efforts.length > 0 &&
      !sameValues(thinking.efforts, current.supportEfforts ?? [])
    ) {
      patch['supportEfforts'] = [...thinking.efforts]
    }

    if (Object.keys(patch).length > 0) {
      result[current.model] = patch
    }
  }

  return result
}
