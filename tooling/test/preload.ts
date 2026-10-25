// 为 UI 测试提供 DOM 全局对象（document、window…）。Core / Host 代码的运行时纯度由 tsconfig 预设保证，不靠测试环境。
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { isolateOmpForTests } from './omp-isolation'

/*
 * 告诉 omp「这是测试进程」。omp 的 isBunTestRuntime() 只认 PI_TEST_RUNTIME=1，或
 * NODE_ENV/BUN_ENV=test 且 Bun.main 是 *.test.ts —— 本仓都不成立，于是每次建测试引擎都当成
 * 生产启动、联网发现模型等满 10 秒超时（全仓基线 ~110 秒涨到 ~176 秒）。必须先于任何测试文件的
 * import 求值；它只影响 omp 的测试进程分支：网络发现关闭、描述缓存不落盘、会话租约走临时目录。
 */
process.env.PI_TEST_RUNTIME = '1'

// omp 的落盘目录全部指到一次性测试数据根（理由见 omp-isolation.ts）。同样必须先于任何测试文件求值。
isolateOmpForTests()

GlobalRegistrator.register({ url: 'http://localhost/', width: 1440, height: 900 })

/*
 * happy-dom 的 Animation.cancel() 照规范 reject 了 finished，却漏了规范同一步里的另一半：
 * reject 之前先把 promise 标成「已处理」（[[PromiseIsHandled]] 置 true）。漏了它，任何一段 motion
 * 动画在播完前被打断（换页、卸载）都会让 bun 判「Unhandled error between tests」，挂掉的是恰好
 * 排在后面的那个用例。在 preload 补上对全仓生效；各测试自己套 skipAnimations 只治装了它的那一份。
 */
const cancelAnimation = Animation.prototype.cancel

Animation.prototype.cancel = function cancel(this: Animation) {
  this.finished.catch(() => undefined)
  cancelAnimation.call(this)
}
