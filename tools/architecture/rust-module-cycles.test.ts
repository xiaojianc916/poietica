import { expect, test } from 'bun:test'
import type { Crate } from './workspace.ts'

/*
 * rustModuleCycles 的判据是文件系统，纯函数部分（模块名归一与边构造）无法脱离
 * 真实 crate 目录测。这里测的是它**读到什么**：cargo metadata 的 directory 必须
 * 指到真实 crate 根，否则规则对一个 crate 空转而不报错。
 *
 * 判例：规则最初靠 crate 名推目录（剥掉 poietica- 前缀），于是
 * poietica-extension-native 落到 crates/extension-native 这个不存在的路径上，
 * 17 个 crate 里 5 个被静默跳过 —— 闸门照常通过，规则却是空转的。
 */

const { readCrates } = await import('./workspace.ts')
const { rustModuleCycles } = await import('./policies.ts')
const { stat } = await import('node:fs/promises')
const path = await import('node:path')

const root = path.resolve(import.meta.dir, '../..')

test('every crate resolves to a directory that really declares it', async () => {
  const crates = readCrates(root)

  expect(crates.length).toBeGreaterThan(0)

  for (const crate of crates) {
    const manifest = path.join(root, crate.directory, 'Cargo.toml')
    const text = await Bun.file(manifest).text()

    expect(text).toContain(`name = "${crate.name}"`)
  }
})

test('crate directory names are not derivable from crate names', () => {
  const crates = readCrates(root)
  const derived = crates.filter(
    (crate) => crate.directory !== `crates/${crate.name.replace(/^poietica-/, '')}`,
  )

  /* 名字推不出目录这件事本身不是缺陷；缺陷是推错了还不说话。 */
  expect(derived.length).toBeGreaterThan(0)
})

test('the scanned crates really have Rust sources', async () => {
  for (const crate of readCrates(root)) {
    const source = path.join(root, crate.directory, 'src')
    const exists = await stat(source).then(
      () => true,
      () => false,
    )

    expect(exists).toBe(true)
  }
})

test('the repository currently has no crate-internal module cycle', async () => {
  expect(await rustModuleCycles(root, readCrates(root))).toHaveLength(0)
})

/*
 * 灵敏度：一条反向边必须报出来。
 *
 * 这条断言抓到过一次真缺陷 —— 重构把源码按模块名收进 Map，于是同一模块目录下
 * 多份文件互相覆盖，只剩最后一份被扫。规则照常通过、覆盖率照常满，灵敏度却是零。
 * 覆盖率证明不了灵敏度，只有注入一条边能。
 */
test('an injected back edge is reported', async () => {
  const target = path.join(root, 'crates/kap-client/src/http.rs')
  const original = await Bun.file(target).text()

  await Bun.write(
    target,
    `${original}\n#[allow(dead_code)]\nfn probe_back_edge() -> usize {\n    crate::session::book::SessionBook::len_hint()\n}\n`,
  )

  let injected: number
  try {
    injected = (await rustModuleCycles(root, readCrates(root))).length
  } finally {
    await Bun.write(target, original)
  }

  expect(injected).toBeGreaterThan(0)
  expect(await rustModuleCycles(root, readCrates(root))).toHaveLength(0)
})

test('a crate with no directory is skipped rather than guessed', async () => {
  const orphan: Crate = {
    name: 'poietica-nowhere',
    dependencies: [],
    directory: 'crates/nowhere',
  }

  expect(await rustModuleCycles(root, [orphan])).toHaveLength(0)
})
