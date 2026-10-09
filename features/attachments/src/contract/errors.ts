import { defineErrors } from '@poietica/contract-kit'

export const attachmentsErrors = defineErrors('attachments', {
  not_found: '附件不存在',
  too_large: '附件超过 50 MB',
  unreadable: '无法读取文件',
})
