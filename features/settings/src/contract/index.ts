import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { SettingContext, SettingSetParams, SettingView } from './entities'
import { settingsErrors } from './errors'

export * from './entities'
export { settingsErrors } from './errors'

export const settingsContract = defineContract({
  id: 'settings',
  namespaces: ['settings'],
  methods: [
    defineMethod({
      name: 'settings.describe',
      owner: 'core',
      params: SettingContext,
      result: z.array(SettingView),
      description: '所有已注册设置项与当前生效值/来源',
    }),
    defineMethod({
      name: 'settings.set',
      owner: 'core',
      params: SettingSetParams,
      result: z.array(SettingView),
      description: '写一个设置项；返回写入后的生效视图',
    }),
  ],
  notifications: [],
  errors: settingsErrors,
})
