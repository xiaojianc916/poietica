import { defineErrors } from '@poietica/contract-kit'

export const intelligentUiErrors = defineErrors('intelligent-ui', {
  thread_not_found: '这条对话不存在或已删除',
  capture_failed: '界面不在窗口的可见区域里，没能截图',
  export_failed: '没能导出界面文件',
})
