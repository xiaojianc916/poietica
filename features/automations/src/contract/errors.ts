import { defineErrors } from '@poietica/contract-kit'

// automations 错误码（07 页 §9B）
export const automationsErrors = defineErrors('automations', {
  not_found: '定时任务不存在',
  invalid_schedule: '计划表达式无效',
  already_running: '这个任务正在运行',
  run_not_found: '运行记录不存在',
  invalid_thread: '续用的对话不可用',
  not_in_run: '这条对话当前没有在运行的定时任务',
  forbidden_in_run: '定时任务运行中不能管理定时任务',
})
