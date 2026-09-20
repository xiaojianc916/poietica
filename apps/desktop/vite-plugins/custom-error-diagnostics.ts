import type { Plugin } from 'vite'

interface UnknownRecord {
  readonly [key: string]: unknown
}

interface SerializableLocation {
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

interface SerializableViteError {
  readonly name: string
  readonly message: string
  readonly stack?: string
  readonly plugin?: string
  readonly id?: string
  readonly frame?: string
  readonly pluginCode?: string
  readonly location?: SerializableLocation
}

interface ViteDiagnosticEvent {
  readonly source: 'vite'
  readonly occurredAt: string
  readonly error: SerializableViteError
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function getString(record: UnknownRecord, property: string): string | undefined {
  const value = record[property]
  return typeof value === 'string' ? value : undefined
}

function getNumber(record: UnknownRecord, property: string): number | undefined {
  const value = record[property]
  return typeof value === 'number' ? value : undefined
}

function getProperty(record: UnknownRecord, property: string): unknown {
  return record[property]
}

function compact<Shape extends object>(
  shape: Shape,
): { [Key in keyof Shape]?: Exclude<Shape[Key], undefined> } {
  return Object.fromEntries(Object.entries(shape).filter(([, value]) => value !== undefined)) as {
    [Key in keyof Shape]?: Exclude<Shape[Key], undefined>
  }
}

function serializeLocation(value: unknown): SerializableLocation | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const file = getString(value, 'file') ?? getString(value, 'id')

  const line = getNumber(value, 'line') ?? getNumber(value, 'lineNumber')

  const column = getNumber(value, 'column') ?? getNumber(value, 'columnNumber')

  if (file === undefined && line === undefined && column === undefined) {
    return undefined
  }

  return compact({ file, line, column })
}

function serializeViteError(value: unknown): SerializableViteError {
  if (value instanceof Error) {
    const errorRecord = value as Error & UnknownRecord

    return {
      name: value.name || 'Error',
      message: value.message || '未知 Vite 错误',
      ...compact({
        stack: value.stack,
        plugin: getString(errorRecord, 'plugin'),
        id: getString(errorRecord, 'id'),
        frame: getString(errorRecord, 'frame'),
        pluginCode: getString(errorRecord, 'pluginCode'),
        location: serializeLocation(getProperty(errorRecord, 'loc')),
      }),
    }
  }

  if (!isRecord(value)) {
    return {
      name: 'ViteError',
      message: typeof value === 'string' ? value : String(value ?? '未知 Vite 错误'),
    }
  }

  return {
    name: getString(value, 'name') ?? 'ViteError',
    message: getString(value, 'message') ?? getString(value, 'msg') ?? '未知 Vite 错误',
    ...compact({
      stack: getString(value, 'stack'),
      plugin: getString(value, 'plugin'),
      id: getString(value, 'id'),
      frame: getString(value, 'frame'),
      pluginCode: getString(value, 'pluginCode'),
      location: serializeLocation(getProperty(value, 'loc')),
    }),
  }
}

function isViteErrorPayload(payload: unknown): payload is UnknownRecord & {
  readonly type: 'error'
  readonly err: unknown
} {
  return isRecord(payload) && getString(payload, 'type') === 'error' && 'err' in payload
}

// Vite 没有公开的自定义 Overlay 替换 API，只能包一层 ws.send：原始错误仍照常转发，额外附带诊断事件。
export function customErrorDiagnosticsPlugin(): Plugin {
  return {
    name: 'poietica:custom-error-diagnostics',
    apply: 'serve',
    configureServer(server) {
      const originalSend = server.ws.send.bind(server.ws)

      const sendOriginal = originalSend as (...arguments_: readonly unknown[]) => unknown

      server.ws.send = ((...arguments_: readonly unknown[]) => {
        const payload = arguments_[0]

        if (isViteErrorPayload(payload)) {
          const diagnostic: ViteDiagnosticEvent = {
            source: 'vite',
            occurredAt: new Date().toISOString(),
            error: serializeViteError(payload.err),
          }

          sendOriginal({
            type: 'custom',
            event: 'poietica:diagnostic',
            data: diagnostic,
          })
        }

        return sendOriginal(...arguments_)
      }) as typeof server.ws.send
    },
  }
}
