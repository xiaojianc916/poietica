import { defineErrors } from '@poietica/contract-kit'

export const terminalErrors = defineErrors('terminal', {
  not_found: '终端不存在或已关闭',
  cwd_not_found: '工作目录不存在',
  too_many: '最多同时打开 10 个终端',
  spawn_failed: '无法启动终端程序',
})
