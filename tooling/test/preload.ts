// 为 UI 测试提供 DOM 全局对象（document、window…）。Core / Host 代码的运行时纯度由 tsconfig 预设保证，不靠测试环境。
import { GlobalRegistrator } from '@happy-dom/global-registrator'

/*
 * 告诉 omp「这是测试进程」。omp 的 isBunTestRuntime()（@oh-my-pi/pi-utils/env）只认
 * PI_TEST_RUNTIME=1，或者 NODE_ENV/BUN_ENV=test **且** Bun.main 是 *.test.ts ——
 * 两者在本仓都不成立（bun test 把 NODE_ENV 留成 development），于是每次 createOmpEngineForTest
 * 都当成生产启动：ModelRegistry 去联网发现模型，refreshIfStale() 等满 10 秒的远程超时。
 * 全仓基线因此从 ~110 秒涨到 ~176 秒，并有 5 条一致性用例超过 5 秒的默认单测超时。
 *
 * 必须在 preload 里设（它先于任何测试文件的 import 求值），而且只影响 omp 的
 * 「测试进程」分支：网络发现关闭、judgment / skill 描述缓存不落盘、会话租约走临时目录。
 */
process.env.PI_TEST_RUNTIME = '1'

GlobalRegistrator.register({ url: 'http://localhost/', width: 1440, height: 900 })

/*
 * happy-dom 的 Animation.cancel() 照规范 reject 了 finished，却漏了规范同一步里的另一半：先把这个 promise 标成
 * 「已处理」（Web Animations 的 cancel() 一节：reject 之前把它的 [[PromiseIsHandled]] 置为 true）。
 * 浏览器里取消一段动画从不产生未处理的 rejection；happy-dom 里它会，于是任何一段 motion 动画在播完前被打断
 * （换页、卸载）都会让 bun 判「Unhandled error between tests」，挂掉的是恰好排在后面的那个用例。
 *
 * 在这里补上那一半，而不是各测试自己套 MotionConfig skipAnimations：后者只治装了它的那一份，组件里新加一段动画，
 * 没套的老测试（比如从整台工作台装起来的那些）就会无端变红。
 */
const cancelAnimation = Animation.prototype.cancel

Animation.prototype.cancel = function cancel(this: Animation) {
  this.finished.catch(() => undefined)
  cancelAnimation.call(this)
}
