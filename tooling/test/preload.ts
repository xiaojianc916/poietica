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
