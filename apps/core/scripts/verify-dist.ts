import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * P7 的产物校验（15 页 §10.2）：重新计算 apps/core/dist/ 里每个产物的 sha256，与
 * core-manifest.json 比对，并断言 `probe === false` —— 防的是「探针版被打进安装包」
 * 这件事：探针版接受 `--probe-mock-model`，装到用户机器上就是一个能拿假模型冒充真模型的 Core。
 *
 * 发布链在 `bunx electron-builder` 之前跑它（15 页 §10.5 第 5 步）。
 * 用法：`bun apps/core/scripts/verify-dist.ts`
 */

const ROOT = path.resolve(import.meta.dir, '../../..')
const dist = path.join(ROOT, 'apps/core/dist')
const manifestFile = path.join(dist, 'core-manifest.json')

interface Manifest {
  readonly coreVersion?: unknown
  readonly protocolVersion?: unknown
  readonly ompVersion?: unknown
  readonly probe?: unknown
  readonly sha256?: unknown
}

function fail(message: string): never {
  console.error(`[verify-dist] ❌ ${message}`)
  process.exit(1)
}

if (!existsSync(manifestFile)) {
  fail(`找不到 ${manifestFile} —— 先跑 bun run core:build`)
}

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest

if (manifest.probe !== false) {
  fail(`manifest 的 probe 是 ${JSON.stringify(manifest.probe)}，不是 false —— 这是探针版，不能发布`)
}
if (typeof manifest.coreVersion !== 'string' || manifest.coreVersion.length === 0) {
  fail('manifest 缺 coreVersion')
}
if (typeof manifest.ompVersion !== 'string' || manifest.ompVersion.length === 0) {
  fail('manifest 缺 ompVersion')
}
if (typeof manifest.protocolVersion !== 'number') {
  fail('manifest 缺 protocolVersion')
}
if (manifest.sha256 === null || typeof manifest.sha256 !== 'object') {
  fail('manifest 缺 sha256 表')
}

const expected = manifest.sha256 as Record<string, unknown>
const problems: string[] = []
const distEntries = readdirSync(dist).filter((name) => name !== 'core-manifest.json')

for (const name of distEntries) {
  const file = path.join(dist, name)
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  const want = expected[name]
  if (want === undefined) {
    problems.push(`${name}：manifest 里没有它的哈希（构建脚本漏记了？）`)
    continue
  }
  if (want !== digest) {
    problems.push(`${name}：哈希不一致\n    盘上 ${digest}\n    manifest ${String(want)}`)
  }
}

for (const name of Object.keys(expected)) {
  if (!distEntries.includes(name)) problems.push(`${name}：manifest 里有，盘上却没有`)
}

if (problems.length > 0) {
  fail(`产物与 manifest 对不上：\n  - ${problems.join('\n  - ')}`)
}

/* omp 版本必须与 catalog 里钉住的 18.5.0 一致（03 页 §0 的第 11 条铁律） */
const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  workspaces?: { catalog?: Record<string, string> }
}
const pinnedOmp = rootPkg.workspaces?.catalog?.['@oh-my-pi/pi-coding-agent']
if (pinnedOmp !== manifest.ompVersion) {
  fail(`omp 版本对不上：manifest ${manifest.ompVersion}，catalog ${String(pinnedOmp)}`)
}

console.log(
  `[verify-dist] ✅ ${distEntries.length} 个产物哈希一致；probe=false；` +
    `core ${String(manifest.coreVersion)} / protocol ${String(manifest.protocolVersion)} / omp ${String(manifest.ompVersion)}`,
)
