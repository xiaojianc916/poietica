import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { KeyOverrides, Preferences, PreferencesPatch, UiStateKey } from './entities'
import { preferencesErrors } from './errors'

export * from './entities'
export { preferencesErrors } from './errors'

const empty = z.object({})
const host = { owner: 'host' } as const

export const preferencesContract = defineContract({
  id: 'preferences',
  namespaces: ['prefs', 'uiState', 'theme', 'keymap'],
  methods: [
    defineMethod({ name: 'prefs.get', ...host, params: empty, result: Preferences, description: '读取当前偏好' }),
    defineMethod({
      name: 'prefs.update',
      ...host,
      params: z.object({ patch: PreferencesPatch }),
      result: Preferences,
      description: '合并写入偏好并执行副作用',
    }),
    defineMethod({
      name: 'uiState.get',
      ...host,
      params: z.object({ key: UiStateKey }),
      result: z.object({ value: z.unknown() }),
      description: '读取界面记忆（缺省为 null）',
    }),
    defineMethod({
      name: 'uiState.set',
      ...host,
      params: z.object({ key: UiStateKey, value: z.unknown() }),
      result: empty,
      description: '写入界面记忆（去抖 500ms 落盘）',
    }),
    defineMethod({
      name: 'theme.set',
      ...host,
      params: z.object({ mode: z.enum(['system', 'light', 'dark']) }),
      result: z.object({ resolved: z.enum(['light', 'dark']) }),
      description: '切换主题（等价于 prefs.update({theme})）',
    }),
    defineMethod({
      name: 'keymap.get',
      ...host,
      params: empty,
      result: z.object({ overrides: KeyOverrides }),
      description: '读取快捷键覆盖表',
    }),
    defineMethod({
      name: 'keymap.set',
      ...host,
      params: z.object({ commandId: z.string(), key: z.string().nullable() }),
      result: z.object({ overrides: KeyOverrides }),
      description: '设置某个命令的按键；null 表示禁用',
    }),
    defineMethod({
      name: 'keymap.reset',
      ...host,
      params: empty,
      result: z.object({ overrides: KeyOverrides }),
      description: '清空覆盖表，恢复默认按键',
    }),
  ],
  notifications: [
    defineNotification({ name: 'prefs.changed', owner: 'host', params: Preferences, description: '偏好变化' }),
    defineNotification({
      name: 'theme.changed',
      owner: 'host',
      params: z.object({ resolved: z.enum(['light', 'dark']) }),
      description: '实际生效的深浅色变化',
    }),
    defineNotification({
      name: 'keymap.changed',
      owner: 'host',
      params: z.object({ overrides: KeyOverrides }),
      description: '快捷键覆盖表变化',
    }),
  ],
  errors: preferencesErrors,
})
