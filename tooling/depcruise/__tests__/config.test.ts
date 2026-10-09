import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * depcruise 配置的**自检**。
 *
 * 背景（真实故障）：`exclude` 与 `doNotFollow` 的分工写错会让规则**静默失效** ——
 * 早先把 `dist` 放进 `exclude`，而 `@oh-my-pi/*` 的 types 指向它自己的 `dist/types/`，
 * 于是 `omp-confined`（「只有 engine-omp 可以 import @oh-my-pi/*」这条铁律）永远不触发，
 * 全仓 0 条 @oh-my-pi 边，`bun run check` 照样全绿。
 *
 * 这条用例把那个类别钉死：`exclude` 只能收我们自己的产物，外部包必须走 `doNotFollow`
 * （只声明不往里走，节点本身仍在图里，针对它的规则照常判定）。
 */
const CONFIG = path.resolve(import.meta.dir, '../config.cjs')

interface Options {
  readonly exclude?: { readonly path?: string }
  readonly doNotFollow?: { readonly path?: string }
}

/** 配置是 CJS（module.exports），动态 import 取 default 即 module.exports */
async function loadOptions(): Promise<Options> {
  const mod = (await import(CONFIG)) as { default?: { options?: Options } }
  return mod.default?.options ?? {}
}

describe('depcruise 配置的自检', () => {
  test('exclude 不含 dist：@oh-my-pi 的 types 指向 dist，排除它就等于让 omp-confined 失效', async () => {
    const exclude = (await loadOptions()).exclude?.path ?? ''
    expect(exclude).not.toContain('dist')
  })

  test('doNotFollow 含 node_modules / dist / vendor：这些是「不往里走」而不是「从图里删掉」', async () => {
    const doNotFollow = (await loadOptions()).doNotFollow?.path ?? ''
    for (const part of ['node_modules', 'dist', 'vendor']) {
      expect(doNotFollow).toContain(part)
    }
  })

  test('omp-confined 规则还在，且例外只有 engine-omp 与 apps/core/scripts', () => {
    const src = readFileSync(CONFIG, 'utf8')
    expect(src).toContain("name: 'omp-confined'")
    expect(src).toContain("pathNot: '^(packages/engine-omp/|apps/core/scripts/)'")
  })

  /*
   * 06 页 A-K1 的验证方式点名规则 `workbench-agnostic`：三个内核包与外壳不得依赖任何
   * `@poietica/feature-*`。这条用例把规则名钉住 —— 规则若改名或被删掉，A-K1 就无从验证。
   */
  test('workbench-agnostic 规则还在：workbench 与三个 *-kernel 都不认识功能', () => {
    const src = readFileSync(CONFIG, 'utf8')
    expect(src).toContain("name: 'workbench-agnostic'")
    expect(src).toContain('^packages/(workbench|core-kernel|host-kernel|ui-kernel)/')
  })

  test('配置能被 depcruise 加载（规则正则不触发 safe-regex 拒绝）', async () => {
    const proc = Bun.spawnSync(['bunx', 'depcruise', '--config', CONFIG, 'packages/foundation/src/index.ts'], {
      cwd: path.resolve(import.meta.dir, '../../..'),
    })
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`
    expect(out).not.toContain('safe-regex')
    expect(out).not.toContain('Invalid')
  })
})
