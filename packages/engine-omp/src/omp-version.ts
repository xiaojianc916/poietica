// omp 引擎版本。engine.info.version 会进入 core.ready 载荷与 diagnostics.core，
// 而 platform 的契约要求它是 string —— 缺了它，strict 模式下 diagnostics.core 整个方法失败。
//
// 为什么不用运行时读取：
//   - \`createRequire(import.meta.url)('@oh-my-pi/pi-coding-agent/package.json')\` 在**编译成单个 exe**
//     之后失败（包里没有可解析的 require 栈）：实测 Core 以退出码 1 反复崩溃，
//     stderr 是 \`Cannot find module '@oh-my-pi/pi-coding-agent/package.json'\`；
//   - 该包也没有 exports \`./package.json\`，静态 import 同样解析不到。
//
// 所以版本由 apps/core/scripts/build.ts 在编译期注入（define），与 POIETICA_BUILD_VERSION 同一机制，
// 也是 omp 官方编译脚本的做法（它注入 PI_COMPILED 等常量）。未注入时（例如直接 bun run 源码、
// 或跑单测）回落到与 catalog 锁定的版本一致的值，绝不返回 undefined。
declare const process: { env: Record<string, string | undefined> }

export const OMP_VERSION: string = process.env.POIETICA_OMP_VERSION ?? '18.5.0'
