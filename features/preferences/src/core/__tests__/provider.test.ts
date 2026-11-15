import { describe, expect, test } from 'bun:test'
import type { HostCaller } from '@poietica/core-kernel'
import { Preferences } from '../../contract'
import { createPreferencesProvider } from '../provider'

describe('preferences settings provider', () => {
  test('读取 Host 当前值，写入翻译成嵌套 patch', async () => {
    let current = Preferences.parse({ theme: 'dark' })
    const patches: unknown[] = []
    const host = {
      call: async (_contract: unknown, name: string, params: unknown) => {
        if (name === 'prefs.get') return current
        if (name === 'prefs.update') {
          patches.push(params)
          current = Preferences.parse({ ...current, ...(params as { patch: object }).patch })
          return current
        }
        throw new Error(`unexpected host call ${name}`)
      },
    } as unknown as HostCaller
    const provider = createPreferencesProvider(host)
    expect(provider.owns('prefs.theme')).toBe(true)
    expect(provider.owns('policy.preset')).toBe(false)
    const views = await provider.describe()
    expect(views.find((view) => view.definition.key === 'prefs.theme')).toMatchObject({
      value: 'dark',
      source: 'global',
    })
    await provider.set?.({ key: 'prefs.general.confirmBeforeDelete', scope: 'global', scopeId: 'global', value: false })
    expect(patches).toEqual([{ patch: { general: { confirmBeforeDelete: false } } }])
  })
})
