import { defineErrors } from '@poietica/contract-kit'

export const platformErrors = defineErrors('platform', {
  url_not_allowed: '只能打开 http、https 或 mailto 链接',
  path_not_found: '路径不存在',
  trash_failed: '无法移到回收站',
})
