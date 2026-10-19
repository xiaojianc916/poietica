import { defineErrors } from '@poietica/contract-kit'

export const intelligentUiErrors = defineErrors('intelligent-ui', {
  thread_not_found: '这条对话不存在或已删除',
})
