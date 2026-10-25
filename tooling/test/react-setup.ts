/*
 * React 的 act 环境开关：react-dom 的 dev 构建把它当运行期开关（不看 NODE_ENV），
 * 不设就每次渲染刷一条 "not configured to support act(...)"。放在全测试共用的
 * preload 里、先于任何测试文件求值，漏一处就刷一屏日志。ESM 严格模式下只能走
 * globalThis；declare global 里只有 var / function 算真正的全局。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export {}
