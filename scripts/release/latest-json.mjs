#!/usr/bin/env bun
/**
 * 由已构建的 NSIS 产物生成 updater 清单。
 *
 * 仓库地址不在这里重复声明：它从 tauri.conf.json 的 updater 端点反推 —— 那正是
 * 客户端真正会去拉的地址，两边不可能再各写各的。
 *
 *   node scripts/release/latest-json.mjs <bundleDir> <outDir> <tag>
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const ENDPOINT = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

const [bundleDir, outDir, tag] = process.argv.slice(2)

if (!bundleDir || !outDir || !tag) {
  console.error('usage: node scripts/release/latest-json.mjs <bundleDir> <outDir> <tag>')
  process.exit(2)
}

const conf = JSON.parse(await readFile(CONF, 'utf8'))
const version = tag.replace(/^v/, '')

if (conf.version !== version) {
  fail(`tag ${tag} does not match the bundled version ${conf.version}`)
}

const base = conf.plugins?.updater?.endpoints?.[0]?.match(ENDPOINT)?.[1]

if (!base) {
  fail(`${CONF}: updater endpoint is not a GitHub latest-release endpoint`)
}

const installer = (await readdir(bundleDir)).find((name) => name.endsWith('-setup.exe'))

if (!installer) {
  fail(`No *-setup.exe under ${bundleDir}`)
}

const signature = await readFile(path.join(bundleDir, `${installer}.sig`), 'utf8').catch(() =>
  fail(
    `Missing ${installer}.sig. Build with pnpm build:release and TAURI_SIGNING_PRIVATE_KEY set.`,
  ),
)

const url = `${base}/releases/download/${tag}/${encodeURIComponent(installer)}`

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  notes: `${base}/releases/tag/${tag}`,
  platforms: {
    'windows-x86_64': { signature: signature.trim(), url },
  },
}

await writeFile(path.join(outDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`latest.json -> ${url}`)
