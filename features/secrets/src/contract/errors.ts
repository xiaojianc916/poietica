import { defineErrors } from '@poietica/contract-kit'

export const secretsErrors = defineErrors('secrets', {
  unavailable: '系统的凭据加密不可用，密钥没有保存',
})
