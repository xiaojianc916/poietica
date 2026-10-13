import { Capabilities as CapabilitiesSchema, SettingDescriptor as SettingDescriptorSchema } from '@poietica/engine'
import { z } from 'zod'

export const Capabilities = CapabilitiesSchema
export const SettingDescriptor = SettingDescriptorSchema
export type Capabilities = z.infer<typeof CapabilitiesSchema>
export type SettingDescriptor = z.infer<typeof SettingDescriptorSchema>

/** 分组顺序与标签来自 engine-omp 设置目录的 SETTING_GROUPS。 */
export const SettingGroup = z.object({
  id: z.string(),
  label: z.string(),
  settings: z.array(SettingDescriptor),
})
export type SettingGroup = z.infer<typeof SettingGroup>
