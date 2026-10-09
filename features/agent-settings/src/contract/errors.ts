import { defineErrors } from '@poietica/contract-kit'

export const agentSettingsErrors = defineErrors('agent-settings', {
  unknown_setting: '不是产品开放的设置项',
  invalid_value: '值不符合这一项的类型约束',
})
