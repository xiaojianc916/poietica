#!/usr/bin/env bun
/**
 * 由安装器真正装出来的那个可执行文件生成更新载荷与清单。
 *
 * 基线取自冒烟测试留下的已安装文件，所以客户端手里的字节与这里的字节逐字相同，
 * 增量的 fromHash 不会对不上。格式与哈希只有一个产出方：crates/update 的
 * poietica-update-payload。
 *
 *   bun tools/release/manifest.ts <installedExe> <outDir> <tag>
 *
 * 端点形态的判定是纯函数；下载、签名与清单落盘只有 main 里那一趟。
 */
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { sign } from './sign.ts'

type GithubRelease = {
  tag_name: string
  draft: boolean
  assets: Array<{ name: string; browser_download_url: string }>
}

const ENDPOINT_FILE = 'apps/desktop/src-tauri/updater/manifest.url'
const ENDPOINT_PATH = 'releases/latest/download/latest.json'
/* 往回追三版：跨得越远的人越少，而每一条增量都要一次全量压缩。 */
const PATCH_DEPTH = 3

/**
 * 清单端点指向的那个 GitHub 仓库；不是 latest-release 形态就给 null。
 *
 * 客户端 updater 读的是同一个文件：端点不是这个形态，签出来的清单就没有
 * 读者能到达的资产基址。
 */
export function manifestBase(endpointText: string): string | null {
  let endpoint: URL

  try {
    endpoint = new URL(endpointText.trim())
  } catch {
    return null
  }

  const [owner, repo, ...rest] = endpoint.pathname.split('/').filter(Boolean)

  if (endpoint.origin !== 'https://github.com' || rest.join('/') !== ENDPOINT_PATH) {
    return null
  }

  if (owner === undefined || repo === undefined) {
    return null
  }

  return `https://github.com/${owner}/${repo}`
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** 载荷生成器的标准输出就是它的返回值：一行哈希。 */
function produce(args: readonly string[]): string {
  const produced = spawnSync(
    'cargo',
    [
      'run',
      '--quiet',
      '-p',
      'poietica-update-native',
      '--bin',
      'poietica-update-payload',
      '--',
      ...args,
    ],
    { encoding: 'utf8' },
  )
  if (produced.status !== 0) {
    console.error(produced.stderr)
    fail(`poietica-update-payload ${args.join(' ')} failed`)
  }
  return produced.stdout.trim()
}

/** 上几版的载荷就是上几版的基线，从已发布的资产取，不在本地缓存里猜。 */
async function baselines(
  base: string,
  tag: string,
): Promise<Array<{ version: string; url: string }>> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (process.env['GITHUB_TOKEN']) {
    headers['authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`
  }
  const [owner, repo] = base.split('/').slice(-2)
  const listed = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`, {
    headers,
  })
  if (!listed.ok) {
    fail(`could not list releases: ${listed.status}`)
  }
  const found: Array<{ version: string; url: string }> = []
  for (const release of (await listed.json()) as GithubRelease[]) {
    if (release.tag_name === tag || release.draft) {
      continue
    }
    const asset = release.assets.find((candidate) => candidate.name.endsWith('.payload.zst'))
    if (asset) {
      found.push({
        version: release.tag_name.replace(/^v/, ''),
        url: asset.browser_download_url,
      })
    }
    if (found.length === PATCH_DEPTH) {
      break
    }
  }
  return found
}

async function fetchTo(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    fail(`could not download ${url}: ${response.status}`)
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function main(): Promise<void> {
  const [installedExe, outDir, tag] = process.argv.slice(2)
  if (!installedExe || !outDir || !tag) {
    console.error('usage: bun tools/release/manifest.ts <installedExe> <outDir> <tag>')
    process.exit(2)
  }
  const version = tag.replace(/^v/, '')

  const base = manifestBase(await readFile(ENDPOINT_FILE, 'utf8'))

  if (base === null) {
    fail(`${ENDPOINT_FILE}: not a GitHub latest-release manifest endpoint`)
  }

  const assetUrl = (name: string): string => `${base}/releases/download/${tag}/${name}`
  const payloadName = `poietica-${version}.payload.zst`

  const full = path.join(outDir, payloadName)
  const payloadHash = produce(['full', installedExe, full])
  const patches: Array<{ fromHash: string; url: string; signature: string }> = []
  for (const previous of await baselines(base, tag)) {
    const basePayload = path.join(outDir, `baseline-${previous.version}.zst`)
    await fetchTo(previous.url, basePayload)
    const name = `poietica-${previous.version}-to-${version}.patch.zst`
    const patch = path.join(outDir, name)
    const fromHash = produce(['patch', basePayload, installedExe, patch])
    patches.push({ fromHash, url: assetUrl(name), signature: await sign(patch) })
    await rm(basePayload)
  }
  const manifest = {
    version,
    notes: `${base}/releases/tag/${tag}`,
    payloadHash,
    full: { url: assetUrl(payloadName), signature: await sign(full) },
    patches,
  }
  await writeFile(path.join(outDir, 'latest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`latest.json: ${version}, ${patches.length} incremental payload(s)`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
