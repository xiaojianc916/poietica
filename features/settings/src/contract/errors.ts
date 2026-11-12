import { defineErrors } from '@poietica/contract-kit'

export const settingsErrors = defineErrors('settings', {
  unknown_key: '设置项没有注册',
  invalid_scope: '该设置项不支持这个作用域',
  invalid_value: '设置值类型不对',
  duplicate_key: '设置项重复注册',
})
