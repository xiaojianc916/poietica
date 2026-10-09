import { Capabilities as CapabilitiesSchema, SettingDescriptor as SettingDescriptorSchema } from '@poietica/engine'
import { z } from 'zod'

/* 值 + 同名类型：与 platform 的 entities.ts 同一个写法（05 页 §6 的实体既要做 schema 也要做类型） */
export const Capabilities = CapabilitiesSchema
export const SettingDescriptor = SettingDescriptorSchema
export type Capabilities = z.infer<typeof CapabilitiesSchema>
export type SettingDescriptor = z.infer<typeof SettingDescriptorSchema>

/** 按 group 归并后的设置目录：分组顺序与标签来自 engine-omp 设置目录的 SETTING_GROUPS */
export const SettingGroup = z.object({
  id: z.string(),
  label: z.string(),
  settings: z.array(SettingDescriptor),
})
export type SettingGroup = z.infer<typeof SettingGroup>
