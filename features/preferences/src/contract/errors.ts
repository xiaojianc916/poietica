import { defineErrors } from '@poietica/contract-kit'

export const preferencesErrors = defineErrors('preferences', {
  write_failed: '偏好写入失败',
  keymap_unknown_command: '未知的命令',
})
