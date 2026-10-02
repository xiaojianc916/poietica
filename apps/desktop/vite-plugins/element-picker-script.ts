import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/*
 * 元素拾取的注入脚本（src/browser/element-picker-runtime.ts）必须自成一个 IIFE 包，
 * 由 electron/browser/element-picker.ts 的 loadPickerScript() 从 dist-electron 读回来。
 *
 * 它不能只挂在 package.json 的 electron:picker 上：那个脚本只有 electron:build 跑，
 * 而主进程每次构建都会清空 dist-electron（实测：改一次 electron/main.ts，先打好的
 * element-picker.js 就被删掉）。于是开发期 loadPickerScript() 落进 catch、缓存 null，
 * host.ts 只 warn 一句 —— 拾取静默起不来，且不报错。
 *
 * 挂在主进程构建的结尾（closeBundle）就与那次清理同序：清空 -> 写 main.cjs -> 重打拾取脚本。
 * 之后的 preload 构建 emptyOutDir: false，不会再清。
 */
/** 与 electron:picker 同一个落点：main.cjs 的 __dirname。 */
const OUT_NAME = 'element-picker.js'

export function elementPickerScriptPlugin(): Plugin {
  let root = ''

  return {
    name: 'poietica:element-picker-script',
    /*
     * 不能写 apply: 'serve'：electron-vite 跑主进程用的是 Vite 的 build（不是 dev server），
     * 写 serve 这个插件在 dev 下一次都不会被调用（实测）。
     */
    apply: 'build',
    configResolved(config) {
      root = config.root
    },
    closeBundle() {
      /*
       * 调 package.json 里那条 electron:picker，而不是在这里抄一遍它的参数：命令只有一份正本。
       *
       * 整条命令写成一个字符串、交给 shell：这个插件跑在 node 里（electron-vite 的宿主），
       * 而 node 的 spawn 不按 PATHEXT 解析 —— 直接找 'bun' 会 ENOENT（真实命令名是 bun.cmd），
       * 找 'bun.cmd' 又会 EINVAL。但**不能**写成 "spawn('bun', [...args], { shell: true })"：
       * 那种组合在 Node 24+ 触发 DEP0190（参数只拼接、不转义）。命令里没有空格与元字符，
       * 一个字符串是等价且无警告的那一种。
       */
      const result = spawnSync('bun run electron:picker', {
        cwd: root,
        stdio: 'inherit',
        shell: true,
      })

      if (result.status !== 0) {
        // 拾取起不来只影响一项开发期功能，不让整个 dev 起不来：与 loadPickerScript 的
        // 「构建期没打出这个文件时按起不来处理」同一条。
        console.error(
          `[poietica] 元素拾取脚本没打成 ${join('dist-electron', OUT_NAME)}，开发期拾取会静默失效`,
        )
      }
    },
  }
}
