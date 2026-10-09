import { defineErrors } from '@poietica/contract-kit'

export const updateErrors = defineErrors('update', {
  disabled: '自动更新不可用',
  invalid_phase: '当前状态不能执行该操作',
})
