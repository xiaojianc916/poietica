import { defineErrors } from '@poietica/contract-kit'

export const conversationErrors = defineErrors('conversation', {
  thread_not_found: '对话不存在',
  thread_busy: '对话正在运行，请先停止',
  thread_empty: '对话还没有任何内容',
  interaction_not_found: '这个请求已经失效',
  /* 入口页铸号失败：用户点了发送但对话没建起来（会显示在输入框上方的失败横幅） */
  thread_start_failed: '无法开始新的对话',
  /* 「Core 即时回显」的三个结局（提交行会显示其中的文案） */
  submit_dropped: '这句话没能发出',
  submit_cancelled: '这句话已停止',
  core_restarted: 'Core 已重启，这条消息没有发出',
})
