import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { Capabilities, SettingDescriptor, SettingGroup } from './entities'
import { agentSettingsErrors } from './errors'

export * from './entities'
export { agentSettingsErrors } from './errors'

const empty = z.object({})

export const agentSettingsContract = defineContract({
  id: 'agent-settings',
  namespaces: ['agentSettings'],
  methods: [
    defineMethod({
      name: 'agentSettings.catalog',
      owner: 'core',
      params: empty,
      result: z.object({ groups: z.array(SettingGroup) }),
      description: '产品开放的 agent 设置，按分组归并',
    }),
    defineMethod({
      name: 'agentSettings.set',
      owner: 'core',
      params: z.object({ path: z.string().min(1), value: z.unknown() }),
      result: SettingDescriptor,
      description: '写入一格设置，返回该设置的最新描述',
    }),
    defineMethod({
      name: 'agentSettings.reset',
      owner: 'core',
      params: z.object({ path: z.string().min(1) }),
      result: SettingDescriptor,
      description: '把一格设置恢复默认',
    }),
    defineMethod({
      name: 'agentSettings.capabilities',
      owner: 'core',
      params: empty,
      result: Capabilities,
      description: '电脑操控与浏览器控制两个能力开关',
    }),
    defineMethod({
      name: 'agentSettings.setCapability',
      owner: 'core',
      params: z.object({ name: z.enum(['computerUse', 'browserControl']), enabled: z.boolean() }),
      result: Capabilities,
      description: '切换一个能力开关',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'agentSettings.changed',
      owner: 'core',
      params: z.object({ paths: z.array(z.string()) }),
      description: '设置变化（路径列表）',
    }),
  ],
  errors: agentSettingsErrors,
})
