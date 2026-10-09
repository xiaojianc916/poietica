/*
 * React 的 act 环境开关。**所有**测试文件共用的 preload（bunfig.toml 的 [test].preload）。
 *
 * React 19 在 act() 里先问一句「这台机器是不是测试环境」：读全局变量
 * IS_REACT_ACT_ENVIRONMENT，读不到就每次更新都打一条
 *
 *   The current testing environment is not configured to support act(...)
 *
 * react-dom 的 dev 构建把它当**运行期**开关（不看 NODE_ENV），所以 Bun 里跑 UI 测试
 * 必须显式声明 —— 这不是在配置某个库，而是替 React 回答它只认全局变量的那个问题。
 *
 * 为什么放 preload 而不是各测试文件里加一行：preload 对全仓测试一次性生效，新写的
 * 测试不会再踩；写进单个文件只能治那一份，而且 React 的这条检查是每次渲染都问的，
 * 漏一处就刷一屏日志（真机上曾出现 20+ 条）。
 *
 * 为什么走 globalThis 而不是裸赋值：ESM 一律严格模式，给未声明的标识符裸赋值是
 * ReferenceError（本文件曾这么写，一跑就炸）。React 那边读的也是 globalThis 上的
 * 同名属性，两边同一个位置。
 *
 * 为什么类型声明是 `var`：`declare global` 里只有 var / function 才算真正的全局，
 * let / const 会被当成模块作用域。配套的 `export {}` 也不能省 —— TS 只允许在模块
 * （external module）里做全局增强。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export {}
