import { describe, expect, test } from 'bun:test'
import type { SettingDescriptor, SettingsPort } from '@poietica/runtime-protocol'
import { createOmpSettingsProvider } from '../provider'

const descriptor = (patch: Partial<SettingDescriptor>): SettingDescriptor => ({
  path: 'model',
  group: 'model',
  groupLabel: '模型',
  label: '默认模型',
  description: '',
  type: 'string',
  options: null,
  value: 'a',
  defaultValue: 'a',
  warning: null,
  condition: null,
  owned: true,
  section: null,
  secret: false,
  hasValue: false,
  ...patch,
})

describe('omp settings provider', () => {
  test('catalog 转成注册表视图；写入走引擎端口，默认值走 reset', async () => {
    const calls: string[] = []
    const settings = {
      catalog: async () => [descriptor({}), descriptor({ path: 'token', secret: true, hasValue: true })],
      set: async (path: string, value: unknown) => {
        calls.push(`set:${path}:${String(value)}`)
      },
      reset: async (path: string) => {
        calls.push(`reset:${path}`)
      },
      getPythonInterpreter: async () => null,
      setPythonInterpreter: async (value: string | null) => {
        calls.push(`python:${String(value)}`)
      },
      injectSecret: async (path: string, value: string | null) => {
        calls.push(`secret:${path}:${String(value)}`)
      },
    } as unknown as SettingsPort
    const provider = createOmpSettingsProvider(settings)
    const views = await provider.describe()
    expect(views.map((view) => view.definition.key)).toEqual(['omp.model', 'omp.token', 'omp.python.interpreter'])
    expect(views[1]).toMatchObject({ value: null, configured: true })

    await provider.set?.({ key: 'omp.model', scope: 'global', scopeId: 'global', value: 'b' })
    await provider.set?.({ key: 'omp.model', scope: 'global', scopeId: 'global', value: 'a' })
    await provider.set?.({ key: 'omp.python.interpreter', scope: 'global', scopeId: 'global', value: 'C:python.exe' })
    await provider.set?.({ key: 'omp.token', scope: 'global', scopeId: 'global', value: 'secret' })
    expect(calls).toEqual(['set:model:b', 'reset:model', 'python:C:python.exe', 'secret:token:secret'])
  })
})
