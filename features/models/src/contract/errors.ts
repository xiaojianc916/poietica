import { defineErrors } from '@poietica/contract-kit'

export const modelsErrors = defineErrors('models', {
  provider_not_found: '模型服务商不存在',
  builtin_provider_readonly: '内置服务商不能删除或修改',
})
