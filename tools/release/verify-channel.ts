#!/usr/bin/env bun
/**
 * 用客户端那条 URL 亲自验一遍发布通道。
 *
 *   bun tools/release/verify-channel.ts <tag>
 *
 * 判定（版本、载荷哈希、产物完整性）是纯函数，网络可达性只有 main 里那一趟。
 */
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const ENDPOINT_FILE = 'apps/desktop/src-tauri/updater/manifest.url'

type Signed = { readonly url?: string; readonly signature?: string }

export type Manifest = {
  readonly version?: string
  readonly payloadHash?: string
  readonly full?: Signed
  readonly patches?: ReadonlyArray<Signed & { readonly fromHash?: string }>
}

export type ChannelArtifact = {
  readonly label: string
  readonly url: string
  readonly signature: string
}

/** 清单里站得住的产物：url 与签名都在的才算一件。 */
export function channelArtifacts(manifest: Manifest): readonly ChannelArtifact[] {
  return [
    { label: 'full', ...pick(manifest.full) },
    ...(manifest.patches ?? []).map((entry, index) => ({
      label: `patch from ${entry.fromHash ?? `#${index + 1}`}`,
      ...pick(entry),
    })),
  ]
}

function pick(entry: Signed | undefined): { url: string; signature: string } {
  return { url: entry?.url ?? '', signature: entry?.signature ?? '' }
}

/**
 * 清单对不上的第一个理由；站得住返回 null。
 *
 * 载荷哈希长度 64：SHA-256 的十六进制写法。长度不对 = 通道发的是别的哈希。
 */
export function channelFault(manifest: Manifest, tag: string): string | null {
  const version = tag.replace(/^v/, '')

  if (manifest.version !== version) {
    return `the published manifest is ${manifest.version}, expected ${version}`
  }

  if (typeof manifest.payloadHash !== 'string' || manifest.payloadHash.length !== 64) {
    return 'the published manifest carries no payload hash'
  }

  for (const artifact of channelArtifacts(manifest)) {
    if (artifact.url === '' || artifact.signature === '') {
      return `${artifact.label} is incomplete`
    }
  }

  return null
}

async function main(): Promise<void> {
  const [tag] = process.argv.slice(2)

  if (tag === undefined) {
    console.error('usage: bun tools/release/verify-channel.ts <tag>')
    process.exit(2)
  }

  const endpoint = (await readFile(ENDPOINT_FILE, 'utf8')).trim()
  const response = await fetch(endpoint, { redirect: 'follow' })

  if (!response.ok) {
    fail(`${endpoint} answered ${response.status}`)
  }

  const manifest = (await response.json()) as Manifest
  const fault = channelFault(manifest, tag)

  if (fault !== null) {
    fail(fault)
  }

  const artifacts = channelArtifacts(manifest)

  for (const artifact of artifacts) {
    const reachable = await fetch(artifact.url, { method: 'HEAD', redirect: 'follow' })

    if (!reachable.ok) {
      fail(`${artifact.label} answered ${reachable.status}`)
    }
  }

  const version = tag.replace(/^v/, '')
  console.log(`update channel: ${version}, ${artifacts.length - 1} incremental payload(s)`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
