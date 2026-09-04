#!/usr/bin/env bun
/**
 * 由已构建的 NSIS 产物生成 updater 清单。
 *
 * 仓库地址不在这里重复声明：它从 tauri.conf.json 的 updater 端点反推 —— 那正是
 * 客户端真正会去拉的地址，两边不可能再各写各的。
 *
 *   bun run latest-json <bundleDir> <outDir> <tag>
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const ENDPOINT = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/

export type UpdaterManifest = {
  readonly version: string
  readonly pub_date: string
  readonly notes: string
  readonly platforms: Record<string, { readonly signature: string; readonly url: string }>
}

export function endpointBase(endpoint: string | undefined): string | undefined {
  return endpoint?.match(ENDPOINT)?.[1]
}

export function buildManifest(base: string, tag: string, installer: string, signature: string) {
  const version = tag.replace(/^v/, '')
  return {
    version,
    pub_date: new Date().toISOString(),
    notes: `${base}/releases/tag/${tag}`,
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `${base}/releases/download/${tag}/${encodeURIComponent(installer)}`,
      },
    },
  } satisfies UpdaterManifest
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function main(): Promise<void> {
  const [bundleDir, outDir, tag] = process.argv.slice(2)
  if (!bundleDir || !outDir || !tag) {
    console.error('用法：bun run latest-json <bundleDir> <outDir> <tag>')
    process.exit(2)
  }

  const conf = JSON.parse(await readFile(CONF, 'utf8')) as {
    version?: string
    plugins?: { updater?: { endpoints?: string[] } }
  }
  const version = tag.replace(/^v/, '')
  if (conf.version !== version) {
    fail(`tag ${tag} 与构建产物版本 ${conf.version ?? '（缺失）'} 对不上`)
  }

  const base = endpointBase(conf.plugins?.updater?.endpoints?.[0])
  if (!base) {
    fail(`${CONF}：updater endpoint 不是 GitHub latest-release 地址`)
  }

  const installer = (await readdir(bundleDir)).find((name) => name.endsWith('-setup.exe'))
  if (!installer) {
    fail(`${bundleDir} 下没有 *-setup.exe`)
  }

  const signature = await readFile(path.join(bundleDir, `${installer}.sig`), 'utf8').catch(() =>
    fail(`缺少 ${installer}.sig：构建时没有签名，检查私钥与密码（~/.tauri/poietica.key）`),
  )

  const manifest = buildManifest(base, tag, installer, signature)
  await writeFile(
    path.join(outDir, 'latest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  console.log(`latest.json -> ${manifest.platforms['windows-x86_64']?.url}`)
}

if (import.meta.main) {
  await main()
}
