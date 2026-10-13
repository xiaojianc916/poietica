import { defineErrors } from '@poietica/contract-kit'

export const browserErrors = defineErrors('browser', {
  invalid_url: '无法识别的地址',
  tab_not_found: '标签不存在',
  /* relay 通道专用的两档：经 rpcResult.error 回给 omp 的浏览器工具，会出现在对话的工具结果里，所以必须有码。relay_ 前缀把「面板自己的方法」与「agent 打进来的命令」分开。 */
  relay_tab_missing: '浏览器面板里没有这个标签',
  relay_address_rejected: '浏览器面板打不开这个地址',
})
