import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CORE_ARTIFACTS } from './artifacts'

/*
 * P7 的产物校验（15 页 §10.2）：重算 apps/core/dist/ 每个产物的 sha256 与 core-manifest.json
 * 比对，并断言 `probe === false` —— 探针版接受 `--probe-mock-model`，打进安装包就是一个能拿
 * 假模型冒充真模型的 Core。发布链在 `bunx electron-builder` 之前跑它。
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

// 哈希自洽只证明「这些文件没有变」，不证明必需文件都在；完整性由固定产物契约约束。
for (const name of CORE_ARTIFACTS) {
  if (!distEntries.includes(name)) problems.push(`${name}：缺少必需产物`)
  if (!Object.hasOwn(expected, name)) problems.push(`${name}：manifest 缺少必需产物的哈希`)
}

for (const name of distEntries) {
  const file = path.join(dist, name)
  const digest = Bun.SHA256.hash(readFileSync(file), 'hex')
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

/* omp 版本必须与 catalog 里钉住的一致（03 页 §0 的第 11 条铁律）—— 具体版本号只有 catalog 一个产地 */
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
