import { defineErrors } from '@poietica/contract-kit'

export const browserErrors = defineErrors('browser', {
  invalid_url: '无法识别的地址',
  tab_not_found: '标签不存在',
  /*
   * relay 通道专用的两档（产品负责人 2026-10-07 定的口径：会传到用户面前的一律 A 类）。
   * 这两条经 `rpcResult.error` 回给 omp 的浏览器工具，最终出现在对话的工具结果里，
   * 所以它们必须有码；`relay_` 前缀把「面板自己的方法」与「agent 经 relay 打进来的命令」
   * 分开 —— 前者抛 browser.* 的通用码，后者抛这里的。
   */
  relay_tab_missing: '浏览器面板里没有这个标签',
  relay_address_rejected: '浏览器面板打不开这个地址',
})
